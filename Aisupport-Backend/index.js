import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { pool, insertChunk, searchOrg, searchDomain } from './db.js';
import { embed, generate } from './ollama.js';
import { chunkText } from './chunk.js';
import { extractText } from './ingest.js';
import { renderPrompt } from './prompt.js';
import { ensureSchema } from './db.js';
import axios from 'axios';
import { generateLLM } from './llm.js';
import { listProviders, PROVIDERS } from './llm.js';

dotenv.config();
const app = express();

// Adjust allowed origins as needed for your frontend
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
  EMBED: parseInt(process.env.TIMEOUT_EMBED || '15000', 10),         // 15s
  SEARCH: parseInt(process.env.TIMEOUT_SEARCH || '15000', 10),       // 15s
  BUILD_PROMPT: parseInt(process.env.TIMEOUT_BUILD_PROMPT || '2000', 10), // 2s
  GENERATE: parseInt(process.env.TIMEOUT_GENERATE || '540000', 10),  // 9 min (below nginx 10m)
};

// Step watchdog should always be a bit longer than the action itself
const STEP_MARGIN = 5000;
function stepTimeout(ms) {
  return ms + STEP_MARGIN;
}

// --------------------
// Helpers
// --------------------
function rid() {
  return Math.random().toString(36).slice(2, 10);
}

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

async function generateWithTimeout({ url, model, prompt, options = {}, timeoutMs = TIMEOUTS.GENERATE }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`LLM generate timeout after ${timeoutMs}ms`), timeoutMs);
  try {
    const { data } = await axios.post(
      `${url}/api/generate`,
      { model, prompt, options, stream: false },
      { signal: controller.signal }
    );
    return typeof data === 'string' ? data : (data.response ?? data);
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * Upload endpoint
 *  /upload?layer=domain
 *  /upload?layer=org&org_id=hospital-x
 * field name: file
 */
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

    // Chunking — keep your existing chunker. (To speed up, increase its chunk size & reduce overlap in its implementation.)
    const chunks = chunkText(text); // e.g., target ~800–1000 chars with 80–120 overlap inside chunkText
    console.log(`[upload] chunks=${chunks.length} concurrency=${EMBED_CONCURRENCY}`);

    const table = layer === 'org' ? 'kb_org' : 'kb_domain';
    const stored = [];
    let okCount = 0, failCount = 0;

    console.time('[upload] embed+insert');

    await mapLimit(chunks, EMBED_CONCURRENCY, async (ch, idx) => {
      // progress every 10 chunks
      if (idx % 10 === 0 || idx === chunks.length - 1) {
        console.log(`[upload] progress ${idx + 1}/${chunks.length}`);
      }

      // 1) embed
      const vec = await embed(ch);

      // 2) metadata
      const id = uuidv4();
      const metadata = {
        source: req.file.originalname,
        layer,
        org_id: layer === 'org' ? org_id : undefined,
        part: idx + 1,
        total_parts: chunks.length,
        kb_version: new Date().toISOString().slice(0, 10)
      };

      // 3) insert
      await insertChunk({
        table,
        id,
        text: ch,
        metadata,
        embedding: vec
      });

      stored[idx] = { id, part: idx + 1 };
      okCount++;
    }).catch(err => {
      // if any single chunk throws, we still want to know how far we got
      console.error('[upload] error during embed/insert:', err);
      throw err;
    });

    console.timeEnd('[upload] embed+insert');
    console.timeEnd('[upload] total');

    return res.json({
      ok: true,
      table,
      parts: okCount,
      failed: failCount,
      chunks: stored.filter(Boolean)
    });

  } catch (e) {
    console.error('[upload] FAILED:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * Ask endpoint
 * body: { question: string, org_id?: string, k1?: number, k2?: number }
 */
// make sure you have: app.use(express.json()) somewhere above
// ⇢ Replace your entire /ask handler with this:
app.post('/ask', async (req, res) => {
  const id = rid();
  const T0 = Date.now();

  // Allow UI to pass provider + per-call timeout; fall back to env/defaults
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

    // 1) Embed
    const qvec = await withStep(id, 'embed', () => embed(question), TIMEOUTS.EMBED);

    // 2) Search (parallel)
    const [orgSnips, domainSnips] = await Promise.all([
      org_id
        ? withStep(id, 'searchOrg', () => searchOrg({ orgId: org_id, queryEmbedding: qvec, limit: k1 }), TIMEOUTS.SEARCH)
        : Promise.resolve([]),
      withStep(id, 'searchDomain', () => searchDomain({ queryEmbedding: qvec, limit: k2 }), TIMEOUTS.SEARCH)
    ]);

    // 3) Build prompt
    const contextSnippets = [...orgSnips, ...domainSnips]
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
      .slice(0, max_ctx);

    const prompt = await withStep(
      id,
      'buildPrompt',
      () => renderPrompt({ contextSnippets, question }),
      TIMEOUTS.BUILD_PROMPT
    );

    // 4) Generate
    const fastDefaults = {
      num_ctx: 1024,
      num_predict: 256,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40
    };

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

    // Unified "used" block
    return res.json({
      answer,
      used: {
        provider,
        model,
        org_id: org_id || null,
        org_hits: orgSnips.length,
        domain_hits: domainSnips.length
      },
      context: contextSnippets.map(s => ({
        id: s.id,
        source: s.metadata?.source,
        distance: s.distance
      })),
      timings_ms: { total }
    });

  } catch (e) {
    console.error(`[ASK][${id}] FAIL:`, e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 8080;

ensureSchema()
  .then(() => {
    app.listen(port, () => console.log(`KB server on :${port}`));
  })
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });

app.get('/llm/providers', (_req, res) => {
  res.json({ providers: listProviders() }); // no secrets
});