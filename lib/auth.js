import crypto from 'node:crypto';
import sql from './db.js';

export const MASTER_EMAIL = 'lucasrodrigues@chatbotmaker.io';
export const ALLOWED_DOMAIN = 'chatbotmaker.io';
export const SESSION_COOKIE = 'softcs_session';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// Vercel roda atrás de proxy (sempre https); em dev local (dev-server.js) não
// há esse header, então assume http.
export function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

export async function createSession(email) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await sql`insert into sessions (token, email, expires_at) values (${token}, ${email}, ${expiresAt})`;
  return { token, expiresAt };
}

export function setSessionCookie(res, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (process.env.VERCEL) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

export async function isEmailAllowed(email) {
  if (email === MASTER_EMAIL) return true;
  const rows = await sql`select 1 from allowed_users where email = ${email}`;
  return rows.length > 0;
}

// Lê a sessão do cookie e valida contra o banco. Não escreve nada em `res` —
// quem chama decide o que fazer com null (401 json, redirect, etc).
export async function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const rows = await sql`select email, expires_at from sessions where token = ${token}`;
  const row = rows[0];
  if (!row || new Date(row.expires_at) < new Date()) return null;

  // Master é sempre master, mesmo que a linha em allowed_users tenha sumido.
  // Pra qualquer outro e-mail, a sessão só vale se ele continuar na lista —
  // isso permite revogar acesso de alguém na hora (remover de allowed_users
  // já invalida as sessões existentes dessa pessoa, não só logins futuros).
  if (row.email !== MASTER_EMAIL && !(await isEmailAllowed(row.email))) return null;

  const role = row.email === MASTER_EMAIL ? 'master' : 'member';
  return { email: row.email, role };
}

// Pra usar no início de handlers de API: já escreve o 401 e retorna null se
// não estiver logado, então o caller só precisa de `if (!user) return;`.
export async function requireSession(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'não autenticado' });
    return null;
  }
  return user;
}

export async function requireMaster(req, res) {
  const user = await requireSession(req, res);
  if (!user) return null;
  if (user.role !== 'master') {
    res.status(403).json({ error: 'somente o master pode fazer isso' });
    return null;
  }
  return user;
}
