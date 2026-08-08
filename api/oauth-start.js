import crypto from 'node:crypto';
import sql from '../lib/db.js';
import { getSetting } from '../lib/settings.js';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Passo 1 do fluxo OAuth (Authorization Code + PKCE), acionado pelo botão
// "Conectar" na aba Agentes. Usado só pra alimentar a busca de tickets em
// /api/discover-tickets — o webhook não depende disso.
export default async function handler(req, res) {
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
    scope: 'tickets:read clients:read offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.writeHead(302, {
    Location: `https://admin.softcs.com.br/api/public/v1/oauth/authorize?${params}`,
  });
  res.end();
}
