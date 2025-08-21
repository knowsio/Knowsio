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

const EMBED_CONCURRENCY = parseInt(process.env.EMBED_CONCURRENCY || '3', 10);

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
app.post('/ask', async (req, res) => {
  const id = rid();
  const T0 = Date.now();

  try {
    const { question, org_id, k1 = 3, k2 = 3, max_ctx = 4, llmOptions = {} } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });

    console.log(`[ASK][${id}] question="${String(question).slice(0,120)}"${question.length>120?'…':''} org=${org_id||'-'}`);

    // 1) Embed
    const qvec = await withStep(id, 'embed', async () => embed(question), 15000);

    // 2) Search (parallel; each logged separately)
    const [orgSnips, domainSnips] = await Promise.all([
      org_id
        ? withStep(id, 'searchOrg', async () => searchOrg({ orgId: org_id, queryEmbedding: qvec, limit: k1 }), 15000)
        : Promise.resolve([]),
      withStep(id, 'searchDomain', async () => searchDomain({ queryEmbedding: qvec, limit: k2 }), 15000)
    ]);

    // 3) Build context/prompt
    const contextSnippets = [...orgSnips, ...domainSnips]
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
      .slice(0, max_ctx);

    await withStep(id, 'buildPrompt', async () => {
      // light work, but we still log it
      return renderPrompt({ contextSnippets, question });
    }, 2000);
    const prompt = renderPrompt({ contextSnippets, question });

    // 4) Generate (fast demo defaults; override with llmOptions)
    const fastDefaults = {
      num_ctx: 1024,
      num_predict: 256,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40
    };

    const answer = await withStep(
      id,
      `generate(${process.env.GEN_MODEL})`,
      async () => generateWithTimeout({
        url: process.env.OLLAMA_URL,
        model: process.env.GEN_MODEL,
        prompt,
        options: { ...fastDefaults, ...(llmOptions || {}) },
        timeoutMs: 60000   // cap single LLM call to 60s for demos
      }),
      65000               // step watchdog slightly higher than fetch timeout
    );

    const total = Date.now() - T0;
    console.log(
      `[ASK][${id}] DONE total=${total}ms hits{org=${orgSnips.length},dom=${domainSnips.length}} ctx=${contextSnippets.length}`
    );

    res.json({
      answer,
      used: {
        org_id: org_id || null,
        org_hits: orgSnips.length,
        domain_hits: domainSnips.length,
        model: process.env.GEN_MODEL
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
