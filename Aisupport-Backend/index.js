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
  seedOrganizations,
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
    res.status(500).json({ error: String(e?.messa
