import crypto from 'node:crypto';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Passo 1 do fluxo OAuth (Authorization Code + PKCE), usado uma única vez para
// autorizar a integração. Acesse /api/oauth-start no navegador, aprove o acesso
// na SoftCS e você será redirecionado para /api/oauth-callback, que salva os
// tokens no Neon.
export default function handler(req, res) {
  const clientId = process.env.SOFTCS_CLIENT_ID;
  const redirectUri = process.env.SOFTCS_REDIRECT_URI;

  const missing = [
    !clientId && 'SOFTCS_CLIENT_ID',
    !redirectUri && 'SOFTCS_REDIRECT_URI',
  ].filter(Boolean);

  if (missing.length > 0) {
    res
      .status(500)
      .send(
        `Variáveis de ambiente faltando na Vercel: ${missing.join(', ')}. Cadastre em Settings > Environment Variables (marcadas para Production) e redeploy.`
      );
    return;
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  res.setHeader('Set-Cookie', [
    `softcs_pkce_verifier=${verifier}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`,
    `softcs_oauth_state=${state}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`,
  ]);

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
