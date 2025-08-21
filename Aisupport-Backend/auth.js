// auth.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { ORGANIZATIONS } from './org-config.js';
import { PROVIDERS } from './llm-config.js';

const JWT_SECRET  = process.env.JWT_SECRET  || 'dev-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

export async function createUser({ email, password, role='user', org_key, provider }) {
  if (!ORGANIZATIONS[org_key]) throw new Error('Invalid org_key');
  if (!PROVIDERS[provider])   throw new Error('Invalid provider');

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, role, org_key, provider)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id, email, role, org_key, provider`,
     [email, hash, role, org_key, provider]
  );
  return rows[0];
}

export async function authenticate(email, password) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  const u = rows[0];
  if (!u) throw new Error('Invalid credentials');
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) throw new Error('Invalid credentials');
  const token = jwt.sign(
    { sub: u.id, role: u.role, org_key: u.org_key, provider: u.provider, email: u.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
  return { token, user: { id: u.id, email: u.email, role: u.role, org_key: u.org_key, provider: u.provider } };
}

export function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    req.user = jwt.verify(token, JWT_SECRET);
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
