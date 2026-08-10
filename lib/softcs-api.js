import sql from './db.js';
import { getSetting, setSettings } from './settings.js';

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

const TOKEN_REFRESH_ALTERNATE_KEY = 'token_refresh_alternate_toggle';

// Chamado ao final de cada ciclo (fase known do polling a cada 5min, ou a
// descoberta completa a cada 15min — ver api/poll-tickets.js e
// api/discover-tickets.js): tenta renovar o token só a cada duas
// finalizações, intercalado, não em toda finalização. Sem efeito prático
// enquanto não houver refresh_token (getValidAccessToken já falha rápido e
// sem custo nesse caso — ver aviso no README), mas evita bater no endpoint
// de renovação a cada 5min sem necessidade quando ele passar a funcionar.
export async function maybeRenewTokenAlternating() {
  const shouldRenewThisTime = (await getSetting(TOKEN_REFRESH_ALTERNATE_KEY)) !== 'true';
  await setSettings({ [TOKEN_REFRESH_ALTERNATE_KEY]: String(shouldRenewThisTime) });
  if (!shouldRenewThisTime) return;
  await getValidAccessToken().catch((err) => console.error('Falha ao renovar token (ciclo intercalado):', err.message));
}

async function apiFetch(path) {
  const token = await getValidAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const retryAfterSeconds = body?.error?.details?.retryAfterSeconds ?? 60;
    const err = new Error(`Limite de requisições da SoftCS atingido — tente de novo em ${retryAfterSeconds}s.`);
    err.rateLimited = true;
    err.retryAfterSeconds = retryAfterSeconds;
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SoftCS API error ${response.status} em ${path}: ${errorText}`);
  }

  return response.json();
}

// 200 é o máximo aceito pela API pra `limit` (tanto em /clients quanto em
// /clients/{id}/tickets). Ordena por updatedAt desc — clientes mexidos
// recentemente têm mais chance de ter ticket aberto, então aparecem primeiro
// ao paginar em lotes. status=ACTIVE filtra clientes inativos/churned
// (confirmado ao vivo que a API honra esse filtro server-side, não só
// devolve o campo) — eles não abrem ticket novo, então escaneá-los só
// desperdiça requisições e aproxima do rate limit à toa.
export function getClients(limit = 200, offset = 0) {
  return apiFetch(`/clients?limit=${limit}&offset=${offset}&sortBy=updatedAt&sortDirection=desc&status=ACTIVE`);
}

// sortBy=kanbanPosition é o mesmo critério de ordenação usado no board visual
// da SoftCS (não vem no corpo da resposta, mas é aceito como parâmetro de sort).
export function getClientTickets(clientId, limit = 200, offset = 0) {
  return apiFetch(
    `/clients/${clientId}/tickets?limit=${limit}&offset=${offset}&sortBy=kanbanPosition&sortDirection=asc`
  );
}

export function getClientContacts(clientId, limit = 200, offset = 0) {
  return apiFetch(`/clients/${clientId}/contacts?limit=${limit}&offset=${offset}`);
}
