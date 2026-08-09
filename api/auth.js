import crypto from 'node:crypto';
import sql from '../lib/db.js';
import {
  baseUrl,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  isEmailAllowed,
  ALLOWED_DOMAIN,
  MASTER_EMAIL,
  parseCookies,
  SESSION_COOKIE,
  requireSession,
  requireMaster,
} from '../lib/auth.js';

const STATE_TTL_MS = 10 * 60 * 1000;

// Passo 1 do login: manda pro consentimento do Google, restrito (via `hd`,
// mais checagem real depois no callback) ao domínio @chatbotmaker.io.
async function handleStart(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('GOOGLE_CLIENT_ID não configurado nas variáveis de ambiente da Vercel.');
    return;
  }

  const state = crypto.randomBytes(16).toString('base64url');
  await sql`insert into google_oauth_state (state) values (${state})`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${baseUrl(req)}/api/auth-callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    hd: ALLOWED_DOMAIN,
    prompt: 'select_account',
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
}

// Passo 2 do login: troca o `code` do Google por token, confirma que o
// e-mail é @chatbotmaker.io verificado e está na allowlist, e cria a sessão.
async function handleCallback(req, res) {
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

async function handleLogout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await sql`delete from sessions where token = ${token}`;
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/login.html' });
  res.end();
}

// Usado pelo admin.js pra saber quem está logado (mostrar e-mail, e liberar
// a aba Acesso só pro master) e pra detectar sessão expirada/inválida (401)
// e mandar pra tela de login.
async function handleMe(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const user = await requireSession(req, res);
  if (!user) return;
  res.status(200).json(user);
}

// CRUD da allowlist de acesso ao painel — só o master pode ver/editar.
async function handleUsers(req, res) {
  const user = await requireMaster(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select email, display_name, added_by, created_at from allowed_users order by created_at asc
    `;
    res.status(200).json(rows.map((r) => ({ ...r, master: r.email === MASTER_EMAIL })));
    return;
  }

  if (req.method === 'POST') {
    const { email, display_name } = req.body ?? {};
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!normalized.endsWith(`@${ALLOWED_DOMAIN}`)) {
      res.status(400).json({ error: `e-mail precisa ser @${ALLOWED_DOMAIN}` });
      return;
    }
    await sql`
      insert into allowed_users (email, display_name, added_by)
      values (${normalized}, ${display_name || null}, ${user.email})
      on conflict (email) do update set display_name = coalesce(excluded.display_name, allowed_users.display_name)
    `;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (email === MASTER_EMAIL) {
      res.status(400).json({ error: 'não dá pra remover o master' });
      return;
    }
    await sql`delete from allowed_users where email = ${email}`;
    await sql`delete from sessions where email = ${email}`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

// Um arquivo só cobrindo /api/auth-start, /api/auth-callback,
// /api/auth-logout, /api/me e /api/users — o plano Hobby da Vercel limita a
// 12 Serverless Functions por deployment, então em vez de um arquivo por
// rota (o que estourava o limite), vercel.json reescreve cada uma dessas
// URLs pra cá com ?action=..., mantendo os endereços externos exatamente
// iguais (nada muda pro Google Console, pro login.html ou pro admin.js).
export default async function handler(req, res) {
  switch (req.query.action) {
    case 'start':
      return handleStart(req, res);
    case 'callback':
      return handleCallback(req, res);
    case 'logout':
      return handleLogout(req, res);
    case 'me':
      return handleMe(req, res);
    case 'users':
      return handleUsers(req, res);
    default:
      res.status(404).json({ error: 'not found' });
  }
}
