import sql from '../lib/db.js';
import { parseCookies, clearSessionCookie, SESSION_COOKIE } from '../lib/auth.js';

export default async function handler(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await sql`delete from sessions where token = ${token}`;
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/login.html' });
  res.end();
}
