import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// NOTE: ensureSchema() creates BOTH KB tables and auth tables/extensions
export async function ensureSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_domain (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      metadata JSONB NOT NULL,
      embedding VECTOR(768) NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_kb_domain_embedding
    ON kb_domain USING ivfflat (embedding vector_cosine_ops);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_org (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata JSONB NOT NULL,
      embedding VECTOR(768) NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_kb_org_embedding
    ON kb_org USING ivfflat (embedding vector_cosine_ops);
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kb_org_orgid ON kb_org(org_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      key   TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user')),
      org_key TEXT NOT NULL REFERENCES organizations(key) ON DELETE RESTRICT,
      provider TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_key);`);
}

export function toVectorLiteral(vec) {
  if (!Array.isArray(vec)) throw new Error('embedding must be an array');
  const nums = vec.map(v => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : 0;
  });
  return `[${nums.join(',')}]`;
}

export async function insertChunk({ table, id, text, metadata, embedding }) {
  const emb = toVectorLiteral(embedding);
  const q = `
    INSERT INTO ${table} (id, text, metadata, embedding${table === 'kb_org' ? ', org_id' : ''})
    VALUES ($1, $2, $3, $4::vector${table === 'kb_org' ? ', $5' : ''})
    ON CONFLICT (id) DO UPDATE
      SET text = EXCLUDED.text,
          metadata = EXCLUDED.metadata,
          embedding = EXCLUDED.embedding
      ${table === 'kb_org' ? ', org_id = EXCLUDED.org_id' : ''}
  `;
  const params = table === 'kb_org'
    ? [id, text, metadata, emb, metadata.org_id]
    : [id, text, metadata, emb];

  await pool.query(q, params);
}

export async function searchOrg({ orgId, queryEmbedding, limit = 6 }) {
  const emb = toVectorLiteral(queryEmbedding);
  const q = `
    SELECT id, text, metadata, (embedding <#> $2::vector) AS distance
    FROM kb_org
    WHERE org_id = $1
    ORDER BY embedding <#> $2::vector
    LIMIT ${limit}
  `;
  const { rows } = await pool.query(q, [orgId, emb]);
  return rows;
}

export async function searchDomain({ queryEmbedding, limit = 4 }) {
  const emb = toVectorLiteral(queryEmbedding);
  const q = `
    SELECT id, text, metadata, (embedding <#> $1::vector) AS distance
    FROM kb_domain
    ORDER BY embedding <#> $1::vector
    LIMIT ${limit}
  `;
  const { rows } = await pool.query(q, [emb]);
  return rows;
}
