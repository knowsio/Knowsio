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
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

    const text = await extractText({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname
    });

    const chunks = chunkText(text);
    const stored = [];

    for (let idx = 0; idx < chunks.length; idx++) {
      const ch = chunks[idx];
      const vec = await embed(ch);
      const id = uuidv4();
      const metadata = {
        source: req.file.originalname,
        layer,
        org_id: layer === 'org' ? org_id : undefined,
        part: idx + 1,
        total_parts: chunks.length,
        kb_version: new Date().toISOString().slice(0,10)
      };
      await insertChunk({
        table: layer === 'org' ? 'kb_org' : 'kb_domain',
        id,
        text: ch,
        metadata,
        embedding: vec
      });
      stored.push({ id, part: idx + 1 });
    }

    res.json({ ok: true, parts: stored.length, chunks: stored });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * Ask endpoint
 * body: { question: string, org_id?: string, k1?: number, k2?: number }
 */
app.post('/ask', async (req, res) => {
  try {
    const { question, org_id, k1 = 6, k2 = 4 } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });

    const qvec = await embed(question);

    const orgSnips = org_id ? await searchOrg({ orgId: org_id, queryEmbedding: qvec, limit: k1 }) : [];
    const domainSnips = await searchDomain({ queryEmbedding: qvec, limit: k2 });

    const contextSnippets = [...orgSnips, ...domainSnips];

    const prompt = renderPrompt({ contextSnippets, question });
    const data = await generate(prompt, { stream: false });

    res.json({
      answer: data?.response || '',
      used: {
        org_id: org_id || null,
        org_hits: orgSnips.length,
        domain_hits: domainSnips.length
      },
      context: contextSnippets.map(s => ({
        id: s.id,
        source: s.metadata?.source,
        distance: s.distance
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
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
