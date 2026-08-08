import sql from '../lib/db.js';

function parseCookies(header) {
  const cookies = {};
  (header ?? '').split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

// Passo 2 do fluxo OAuth: recebe o `code` da SoftCS, troca por access/refresh
// token e grava em softcs_oauth_tokens. Só precisa rodar uma vez (o token é
// renovado sozinho depois, via lib/softcs.js).
export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`Autorização recusada pela SoftCS: ${error}`);
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  if (!state || state !== cookies.softcs_oauth_state) {
    res.status(400).send('state inválido ou expirado — refaça o fluxo acessando /api/oauth-start');
    return;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.SOFTCS_REDIRECT_URI,
    client_id: process.env.SOFTCS_CLIENT_ID,
    client_secret: process.env.SOFTCS_CLIENT_SECRET,
    code_verifier: cookies.softcs_pkce_verifier,
  });

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
    values (1, ${tokens.access_token}, ${tokens.refresh_token}, ${expiresAt})
    on conflict (id) do update set
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = now()
  `;

  res.status(200).send('Autorização concluída — tokens salvos no Neon. Pode fechar esta aba.');
}
