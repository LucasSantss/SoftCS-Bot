import crypto from 'node:crypto';
import sql from '../lib/db.js';
import { getSetting } from '../lib/settings.js';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Passo 1 do fluxo OAuth (Authorization Code + PKCE), usado uma única vez para
// autorizar a integração. Acessado a partir do botão "Autorizar" em /admin.html.
// O code_verifier fica guardado no banco (chaveado por `state`) em vez de num
// cookie, porque a Vercel expõe várias URLs pro mesmo projeto e um cookie
// setado numa não é enviado de volta pra outra.
export default async function handler(req, res) {
  const clientId = await getSetting('softcs_client_id');
  const redirectUri = await getSetting('softcs_redirect_uri');

  const missing = [!clientId && 'Client ID', !redirectUri && 'Redirect URI'].filter(Boolean);

  if (missing.length > 0) {
    res.status(400).send(`Configure em /admin.html antes de autorizar: ${missing.join(', ')}.`);
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
    scope: 'openid offline_access tickets:read clients:read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.writeHead(302, {
    Location: `https://admin.softcs.com.br/api/public/v1/oauth/authorize?${params}`,
  });
  res.end();
}
