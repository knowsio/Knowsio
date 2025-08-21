// auth.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { ORGANIZATIONS } from './organizations.js';
import { PROVIDERS } from './llm.js';

const JWT_SECRET  = process.env.JWT_SECRET  || 'dev-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function issueToken({ id, email, role, org_key, provider }) {
  return jwt.sign({ sub: id, email, role, org_key, provider }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Attach req.user if valid; otherwise 401
export function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing Bearer token' });
    const payload = verifyToken(m[1]);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      org_key: payload.org_key,
      provider: payload.provider
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

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
