import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import axios from 'axios';

import { pool, insertChunk, searchOrg, searchDomain, ensureSchema } from './db.js';
import { embed } from './ollama.js';
import { chunkText } from './chunk.js';
import { extractText } from './ingest.js';
import { renderPrompt } from './prompt.js';

import { generateLLM, listProviders, PROVIDERS } from './llm.js';
import { ORGANIZATIONS, listOrganizations as listOrgsStatic } from './organizations.js';

import {
  createUser,
  authenticate,
  requireAuth,
  requireRole,
  hashPassword,
  verifyPassword,
  issueToken,
  getUserByEmail,
  listUsers,
  updateUser,
  seedOrganizations
} from './auth.js';

dotenv.config();
const app = express();

app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ]
}));
app.use(express.json({ limit: '2mb' }));
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// Health
app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

const EMBED_CONCURRENCY = parseInt(process.env.EMBED_CONCURRENCY || '3', 10);

// --------------------
// Timeout constants
// --------------------
const TIMEOUTS = {
  EMBED: parseInt(process.env.TIMEOUT_EMBED || '15000', 10),              // 15s
  SEARCH: parseInt(process.env.TIMEOUT_SEARCH || '15000', 10),            // 15s
  BUILD_PROMPT: parseInt(process.env.TIMEOUT_BUILD_PROMPT || '2000', 10), // 2s
  GENERATE: parseInt(process.env.TIMEOUT_GENERATE || '540000', 10),       // 9 min
};
const STEP_MARGIN = 5000;
function stepTimeout(ms) { return ms + STEP_MARGIN; }

// Helpers
function rid() { return Math.random().toString(36).slice(2, 10); }
async function withStep(id, label, fn, timeoutMs = TIMEOUTS.GENERATE) {
  const t0 = Date.now();
  console.log(`[STEP][${id}] ${label} start`);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Step "${label}" timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    const result = await Promise.race([Promise.resolve().then(fn), timeout]);
    console.log(`[STEP][${id}] ${label} ok ${Date.now() - t0}ms`);
    return result;
  } catch (e) {
    console.error(`[STEP][${id}] ${label} FAIL ${Date.now() - t0}ms`, e);
    throw e;
  }
}

// -------------------- AUTH --------------------
app.post('/auth/bootstrap-admin', async (req, res) => {
  try {
    const { email, password, org_key='MMM', provider='OLLAMA' } = req.body || {};
    if (!email || !password || !org_key || !provider) {
      return res.status(400).json({ error: 'email, password, org_key, provider are required' });
    }

    // if any admin exists, new one becomes 'user'; first one becomes 'admin'
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE role='admin' LIMIT 1`);
    const role = rows.length ? 'user' : 'admin';

    const exists = await getUserByEmail(email);
    if (exists) return res.status(409).json({ error: 'email already exists' });

    const user = await createUser({ email, password, role, org_key, provider });
    const token = issueToken(user);
    res.json({ ok: true, user, token, roleAssigned: role });
  } catch (e) {
    console.error('/auth/bootstrap-admin FAIL', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email & password required' });
    const out = await authenticate(email, password);
    res.json(out);
  } catch {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ----- Admin user management -----
app.get('/users', requireAuth, requireRole('admin'), async (_req, res) => {
  res.json({ users: await listUsers() });
});
app.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { email, password, role='user', org_key, provider } = req.body || {};
    if (!email || !password || !org_key || !provider) return res.status(400).json({ error: 'missing fields' });
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'email already exists' });
    const user = await createUser({ email, password, role, org_key, provider });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
app.patch('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const patch = {};
    for (const k of ['role','org_key','provider']) if (req.body[k]) patch[k] = req.body[k];
    if (req.body.password) patch.password_hash = await hashPassword(req.body.password);
    const user = await updateUser(id, patch);
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Organizations list for UI dropdowns (auth required; falls back to static if table empty)
app.get('/organizations', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`SELECT key,label FROM organizations ORDER BY key`);
  res.json({ organizations: rows.length ? rows : listOrgsStatic() });
});

// -------------------- Upload --------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { layer, org_id } = req.query;
    if (!layer || !['domain', 'org'].includes(layer)) {
      return res.status(400).json({ error: "Missing or invalid ?layer=domain|org" });
    }
    if (layer === 'org' && !org_id) {
      return res.status(400).json({ error: "Missing ?org_id=..." });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
    }

    console.time('[upload] total');
    console.log(`[upload] file="${req.file.originalname}" type=${req.file.mimetype} size=${req.file.size}B layer=${layer} org_id=${org_id || '-'}`);
    console.time('[upload] extract');

    const text = await extractText({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname
    });

    console.timeEnd('[upload] extract');
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Uploaded file contains no extractable text' });
    }

    const chunks = chunkText(text);
    console.log(`[upload] chunks=${chunks.length} concurrency=${EMBED_CONCURRENCY}`);

    const table = layer === 'org' ? 'kb_org' : 'kb_domain';
    const stored = [];
    let okCount = 0;

    console.time('[upload] embed+insert');

    // tiny concurrency helper
    async function mapLimit(items, limit, fn) {
      const out = new Array(items.length);
      let i = 0, inFlight = 0;
      return new Promise((resolve, reject) => {
        const next = () => {
          if (i >= items.length && inFlight === 0) return resolve(out);
          while (inFlight < limit && i < items.length) {
            const idx = i++;
            inFlight++;
            Promise.resolve(fn(items[idx], idx))
              .then(v => { out[idx] = v; })
              .catch(reject)
              .finally(() => { inFlight--; next(); });
          }
        };
        next();
      });
    }

    await mapLimit(chunks, EMBED_CONCURRENCY, async (ch, idx) => {
      if (idx % 10 === 0 || idx === chunks.length - 1) {
        console.log(`[upload] progress ${idx + 1}/${chunks.length}`);
      }
      const vec = await embed(ch);
      const id = uuidv4();
      const metadata = {
        source: req.file.originalname,
        layer,
        org_id: layer === 'org' ? org_id : undefined,
        part: idx + 1,
        total_parts: chunks.length,
        kb_version: new Date().toISOString().slice(0, 10)
      };
      await insertChunk({
        table,
        id,
        text: ch,
        metadata,
        embedding: vec
      });
      stored[idx] = { id, part: idx + 1 };
      okCount++;
    });

    console.timeEnd('[upload] embed+insert');
    console.timeEnd('[upload] total');

    return res.json({
      ok: true,
      table,
      parts: okCount,
      failed: 0,
      chunks: stored.filter(Boolean)
    });
  } catch (e) {
    console.error('[upload] FAILED:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// -------------------- Ask --------------------
app.post('/ask', async (req, res) => {
  const id = rid();
  const T0 = Date.now();

  const {
    provider: reqProvider,
    llmOptions = {},
    genTimeoutMs
  } = req.body || {};

  const provider = (reqProvider || process.env.PROVIDER || 'OLLAMA').toUpperCase();
  if (!PROVIDERS[provider]) {
    return res.status(400).json({ error: `Unsupported provider: ${provider}` });
  }
  const model = PROVIDERS[provider].defaultModel;

  try {
    const { question, org_id, k1 = 3, k2 = 3, max_ctx = 4 } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });

    console.log(`[ASK][${id}] question="${String(question).slice(0,120)}"${question.length>120?'…':''} org=${org_id || '-'}`);

    const qvec = await withStep(id, 'embed', () => embed(question), TIMEOUTS.EMBED);

    const [orgSnips, domainSnips] = await Promise.all([
      org_id ? withStep(id, 'searchOrg', () => searchOrg({ orgId: org_id, queryEmbedding: qvec, limit: k1 }), TIMEOUTS.SEARCH) : Promise.resolve([]),
      withStep(id, 'searchDomain', () => searchDomain({ queryEmbedding: qvec, limit: k2 }), TIMEOUTS.SEARCH)
    ]);

    const contextSnippets = [...orgSnips, ...domainSnips]
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
      .slice(0, max_ctx);

    const prompt = await withStep(
      id,
      'buildPrompt',
      () => renderPrompt({ contextSnippets, question }),
      TIMEOUTS.BUILD_PROMPT
    );

    const fastDefaults = { num_ctx: 1024, num_predict: 256, temperature: 0.2, top_p: 0.9, top_k: 40 };

    const answer = await withStep(
      id,
      `generate(${provider}:${model})`,
      () => generateLLM({
        provider,
        model,
        prompt,
        options: { ...fastDefaults, ...(llmOptions || {}) },
        timeoutMs: genTimeoutMs || TIMEOUTS.GENERATE
      }),
      stepTimeout(genTimeoutMs || TIMEOUTS.GENERATE)
    );

    const total = Date.now() - T0;
    console.log(`[ASK][${id}] DONE total=${total}ms hits{org=${orgSnips.length},dom=${domainSnips.length}} ctx=${contextSnippets.length}`);

    return res.json({
      answer,
      used: { provider, model, org_id: org_id || null, org_hits: orgSnips.length, domain_hits: domainSnips.length },
      context: contextSnippets.map(s => ({ id: s.id, source: s.metadata?.source, distance: s.distance })),
      timings_ms: { total }
    });

  } catch (e) {
    console.error(`[ASK][${id}] FAIL:`, e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// -------------------- Config for UI --------------------
app.get('/llm/providers', (_req, res) => {
  res.json({ providers: listProviders() });
});
app.get('/config', requireAuth, (req, res) => {
  res.json({
    me: {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role,
      org_key: req.user.org_key,
      provider: req.user.provider,
    },
    providers: listProviders(),
    organizations: listOrgsStatic(), // UI can also call /organizations for DB-backed list
  });
});

// ---- boot ----
const port = process.env.PORT || 8080;
Promise.resolve()
  .then(() => ensureSchema())                   // KB + auth tables
  .then(() => seedOrganizations(ORGANIZATIONS)) // seed orgs table
  .then(() => {
    app.listen(port, () => console.log(`KB server on :${port}`));
  })
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
