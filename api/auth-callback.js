import sql from '../lib/db.js';
import { baseUrl, createSession, setSessionCookie, isEmailAllowed, ALLOWED_DOMAIN } from '../lib/auth.js';

const STATE_TTL_MS = 10 * 60 * 1000;

// Passo 2 do login: troca o `code` do Google por token, confirma que o
// e-mail é @chatbotmaker.io verificado e está na allowlist, e cria a sessão.
export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: `/login.html?error=${encodeURIComponent(error)}` });
    res.end();
    return;
  }
  if (!code || !state) {
    res.status(400).send('code ou state ausentes na resposta do Google.');
    return;
  }

  const rows = await sql`select created_at from google_oauth_state where state = ${state}`;
  const row = rows[0];
  await sql`delete from google_oauth_state where state = ${state}`;

  if (!row) {
    res.status(400).send('state não encontrado (já usado ou nunca existiu) — tente entrar de novo.');
    return;
  }
  if (Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS) {
    res.status(400).send('state expirado — tente entrar de novo.');
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${baseUrl(req)}/api/auth-callback`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    res.status(500).send(`Falha ao trocar code por token com o Google (${tokenResponse.status}): ${text}`);
    return;
  }

  const tokens = await tokenResponse.json();

  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userInfoResponse.ok) {
    res.status(500).send('Falha ao buscar dados da conta no Google.');
    return;
  }

  const userInfo = await userInfoResponse.json();
  const email = String(userInfo.email || '').toLowerCase();

  if (!userInfo.email_verified || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    res.writeHead(302, { Location: '/login.html?error=domain' });
    res.end();
    return;
  }

  if (!(await isEmailAllowed(email))) {
    res.writeHead(302, { Location: '/login.html?error=not_allowed' });
    res.end();
    return;
  }

  const { token, expiresAt } = await createSession(email);
  setSessionCookie(res, token, expiresAt);

  res.writeHead(302, { Location: '/' });
  res.end();
}
