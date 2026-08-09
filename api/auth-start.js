import crypto from 'node:crypto';
import sql from '../lib/db.js';
import { baseUrl, ALLOWED_DOMAIN } from '../lib/auth.js';

// Passo 1 do login: manda pro consentimento do Google, restrito (via `hd`,
// mais checagem real depois no callback) ao domínio @chatbotmaker.io.
export default async function handler(req, res) {
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
