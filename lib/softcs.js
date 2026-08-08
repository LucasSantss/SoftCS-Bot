import sql from './db.js';

const API_BASE = 'https://admin.softcs.com.br/api/public/v1';

// Margem de segurança para renovar o token antes dele expirar de fato.
const REFRESH_MARGIN_MS = 60 * 1000;

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.SOFTCS_CLIENT_ID;
  const clientSecret = process.env.SOFTCS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('SOFTCS_CLIENT_ID ou SOFTCS_CLIENT_SECRET não configurados');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha ao renovar token SoftCS (${response.status}): ${errorText}`);
  }

  return response.json();
}

// Retorna um access_token válido, renovando via refresh_token quando necessário.
// O primeiro par access_token/refresh_token precisa ser inserido manualmente na
// tabela softcs_oauth_tokens após a autorização inicial (ver README).
export async function getValidAccessToken() {
  const rows = await sql`select access_token, refresh_token, expires_at from softcs_oauth_tokens where id = 1`;
  const row = rows[0];

  if (!row) {
    throw new Error(
      'Nenhum token SoftCS cadastrado em softcs_oauth_tokens. Faça a autorização OAuth inicial (ver README) e insira o access_token/refresh_token.'
    );
  }

  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - REFRESH_MARGIN_MS) {
    return row.access_token;
  }

  const refreshed = await refreshAccessToken(row.refresh_token);
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  await sql`
    update softcs_oauth_tokens
    set access_token = ${refreshed.access_token},
        refresh_token = ${refreshed.refresh_token ?? row.refresh_token},
        expires_at = ${newExpiresAt},
        updated_at = now()
    where id = 1
  `;

  return refreshed.access_token;
}

async function apiFetch(path) {
  const token = await getValidAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SoftCS API error ${response.status} em ${path}: ${errorText}`);
  }

  return response.json();
}

export function getTicket(clientId, ticketId) {
  return apiFetch(`/clients/${clientId}/tickets/${ticketId}`);
}

export function getClient(clientId) {
  return apiFetch(`/clients/${clientId}`);
}

// Busca o @username do Telegram cadastrado manualmente para um usuário SoftCS.
// Retorna null se ainda não houver mapeamento (o ID precisa ser adicionado à mão
// em agent_mapping, já que a API pública não expõe uma lista de agentes/usuários).
export async function getTelegramMention(softcsUserId) {
  if (!softcsUserId) return null;
  const rows = await sql`
    select telegram_username from agent_mapping where softcs_user_id = ${softcsUserId}
  `;
  const username = rows[0]?.telegram_username;
  return username ? `@${username.replace(/^@/, '')}` : null;
}
