// auth.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { ORGANIZATIONS } from './organizations.js';
import { PROVIDERS } from './llm.js';

const JWT_SECRET  = process.env.JWT_SECRET  || 'dev-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// ----- password helpers -----
export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ----- jwt helpers -----
export function issueToken({ id, email, role, org_key, provider }) {
  return jwt.sign({ sub: id, email, role, org_key, provider }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ----- auth middleware -----
export function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    const payload = verifyToken(token);
    req.user = {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      org_key: payload.org_key,
      provider: payload.provider,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (req.user.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// ----- user ops -----
export async function createUser({ email, password, role='user', org_key, provider }) {
  if (!ORGANIZATIONS[org_key]) throw new Error('Invalid org_key');
  if (!PROVIDERS[provider])   throw new Error('Invalid provider');

  const password_hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, role, org_key, provider)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id, email, role, org_key, provider`,
     [email, password_hash, role, org_key, provider]
  );
  return rows[0];
}

export async function authenticate(email, password) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  const u = rows[0];
  if (!u) throw new Error('Invalid credentials');
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) throw new Error('Invalid credentials');
  const token = issueToken({ id: u.id, email: u.email, role: u.role, org_key: u.org_key, provider: u.provider });
  return { token, user: { id: u.id, email: u.email, role: u.role, org_key: u.org_key, provider: u.provider } };
}

export async function getUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  return rows[0] || null;
}
export async function getUserById(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function listUsers() {
  const { rows } = await pool.query(`SELECT id,email,role,org_key,provider,created_at FROM users ORDER BY created_at DESC`);
  return rows;
}
export async function updateUser(id, fields) {
  const cols = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k}=$${i++}`);
    vals.push(v);
  }
  if (!cols.length) return getUserById(id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${cols.join(', ')}, updated_at=now() WHERE id=$${i} RETURNING id,email,role,org_key,provider,created_at`,
    vals
  );
  return rows[0] || null;
}

// ----- org seeding -----
export async function seedOrganizations(orgs) {
  if (!orgs || !Object.keys(orgs).length) return;
  const text = `INSERT INTO organizations(key,label) VALUES ($1,$2)
                ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label`;
  for (const [key, v] of Object.entries(orgs)) {
    await pool.query(text, [key, v.label]);
  }
}
