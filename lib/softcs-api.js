import sql from './db.js';
import { getSetting } from './settings.js';

const API_BASE = 'https://admin.softcs.com.br/api/public/v1';

// Margem de segurança para renovar o token antes dele expirar de fato.
const REFRESH_MARGIN_MS = 60 * 1000;

async function refreshAccessToken(refreshToken) {
  const clientId = await getSetting('softcs_client_id');
  const clientSecret = await getSetting('softcs_client_secret');

  if (!clientId || !clientSecret) {
    throw new Error('Credenciais OAuth da SoftCS não configuradas');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  // client_secret_basic, não client_id/secret no corpo — ver api/oauth-callback.js.
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha ao renovar token SoftCS (${response.status}): ${errorText}`);
  }

  return response.json();
}

// Retorna um access_token válido, renovando via refresh_token quando necessário.
export async function getValidAccessToken() {
  const rows = await sql`select access_token, refresh_token, expires_at from softcs_oauth_tokens where id = 1`;
  const row = rows[0];

  if (!row) {
    throw new Error('Integração SoftCS ainda não conectada — clique em "Conectar" na aba Agentes.');
  }

  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - REFRESH_MARGIN_MS) {
    return row.access_token;
  }

  if (!row.refresh_token) {
    throw new Error(
      'Token da SoftCS expirou e não há refresh_token (aplicação sem offline_access) — clique em "Conectar" de novo na aba Agentes.'
    );
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

export function getClients(limit = 30, offset = 0) {
  return apiFetch(`/clients?limit=${limit}&offset=${offset}`);
}

export function getClientTickets(clientId, limit = 50, offset = 0) {
  return apiFetch(`/clients/${clientId}/tickets?limit=${limit}&offset=${offset}`);
}
