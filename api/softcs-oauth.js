import crypto from 'node:crypto';
import sql from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { getSessionUser } from '../lib/auth.js';
import { triggerPollWorkflows } from '../lib/github-actions.js';

const STATE_TTL_MS = 10 * 60 * 1000;

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Passo 1 do fluxo OAuth (Authorization Code + PKCE), acionado pelo botão
// "Conectar" na aba Agentes. Usado só pra alimentar a busca de tickets em
// /api/discover-tickets — o webhook não depende disso.
async function handleStart(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return;
  }

  const clientId = await getSetting('softcs_client_id');
  const redirectUri = await getSetting('softcs_redirect_uri');

  const missing = [!clientId && 'Client ID', !redirectUri && 'Redirect URI'].filter(Boolean);
  if (missing.length > 0) {
    res.status(400).send(`Configure antes de conectar: ${missing.join(', ')}.`);
    return;
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  await sql`insert into oauth_pkce_state (state, code_verifier) values (${state}, ${verifier})`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // offline_access é o que garante o refresh_token (senão o access_token expira
    // em ~1h e é preciso clicar em Conectar toda vez). Precisa estar habilitado em
    // Identidade > "Continuar conectada mesmo após sair" na aplicação da SoftCS,
    // senão volta o invalid_scope.
    scope: 'tickets:read clients:read contacts:read offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.writeHead(302, {
    Location: `https://admin.softcs.com.br/api/public/v1/oauth/authorize?${params}`,
  });
  res.end();
}

// Passo 2 do fluxo OAuth: recebe o `code` da SoftCS, busca o code_verifier
// guardado no passo 1 (pelo `state`), troca por access/refresh token e
// grava em softcs_oauth_tokens.
async function handleCallback(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return;
  }

  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`Autorização recusada pela SoftCS: ${error}`);
    return;
  }

  if (!state || !code) {
    res.status(400).send('code ou state ausentes na resposta da SoftCS.');
    return;
  }

  const rows = await sql`
    select code_verifier, created_at from oauth_pkce_state where state = ${state}
  `;
  const row = rows[0];

  if (!row) {
    res
      .status(400)
      .send('state não encontrado (já usado ou nunca existiu) — refaça o fluxo clicando em Conectar de novo.');
    return;
  }

  await sql`delete from oauth_pkce_state where state = ${state}`;

  if (Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS) {
    res.status(400).send('state expirado (mais de 10 minutos) — refaça o fluxo clicando em Conectar de novo.');
    return;
  }

  const [redirectUri, clientId] = await Promise.all([
    getSetting('softcs_redirect_uri'),
    getSetting('softcs_client_id'),
  ]);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: row.code_verifier,
  });

  // Nada de Authorization: Basic (client_secret_basic) nem client_secret em
  // lugar nenhum — testado ao vivo, byte a byte, direto no Postman sem
  // nenhum código nosso no meio: é isso que faz a SoftCS finalmente
  // devolver refresh_token (client_secret_basic sempre resultava em scope
  // sem offline_access e sem refresh_token, mesmo pedindo certinho — parece
  // que essa aplicação é tratada como cliente público, PKCE só, do lado
  // deles). A doc oficial diz client_secret_basic, mas o comportamento real
  // é outro — confiamos no que foi observado, não no que está escrito.
  const response = await fetch('https://admin.softcs.com.br/api/public/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    res.status(500).send(`Falha ao trocar code por token (${response.status}): ${text}`);
    return;
  }

  const tokens = await response.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await sql`
    insert into softcs_oauth_tokens (id, access_token, refresh_token, expires_at)
    values (1, ${tokens.access_token}, ${tokens.refresh_token ?? null}, ${expiresAt})
    on conflict (id) do update set
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = now()
  `;

  // Dispara os workflows de polling na hora em vez de esperar o próximo
  // tick do cron — sem refresh_token, essa reconexão manual só rende ~15min
  // de token válido, e não vale desperdiçar parte disso esperando o
  // relógio do GitHub Actions (ver lib/github-actions.js). Não trava o
  // redirect se falhar (ex: GITHUB_DISPATCH_TOKEN não configurado ainda).
  await triggerPollWorkflows();

  // "Conectar" navega a própria aba pra cá (ver admin.js — popup foi
  // tentado e abandonado: bloqueador de popup e Cross-Origin-Opener-Policy
  // causavam falhas diferentes, fora do nosso controle). Volta sozinho pro
  // painel assim que o token é salvo — nada de página morta pra fechar
  // manualmente; boot() no admin.js já mostra o badge "conectado" na hora.
  res.writeHead(302, { Location: '/' });
  res.end();
}

// Um arquivo só cobrindo /api/oauth-start e /api/oauth-callback (SoftCS) —
// mesma razão do api/auth.js: ficar dentro do limite de 12 Serverless
// Functions do plano Hobby da Vercel. vercel.json reescreve as duas URLs pra
// cá com ?action=..., sem mudar nada externamente (a redirect URI cadastrada
// na aplicação OAuth2 da SoftCS continua /api/oauth-callback).
export default async function handler(req, res) {
  if (req.query.action === 'callback') return handleCallback(req, res);
  return handleStart(req, res);
}
