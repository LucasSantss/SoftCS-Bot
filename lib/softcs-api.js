import sql from './db.js';
import { getSetting } from './settings.js';

const API_BASE = 'https://admin.softcs.com.br/api/public/v1';

// Margem de segurança para renovar o token antes dele expirar de fato.
const REFRESH_MARGIN_MS = 60 * 1000;

async function refreshAccessToken(refreshToken) {
  const clientId = await getSetting('softcs_client_id');

  if (!clientId) {
    throw new Error('Credenciais OAuth da SoftCS não configuradas');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });

  // Nada de Authorization: Basic (client_secret_basic) nem client_secret —
  // testado ao vivo direto no Postman: com Basic auth esse grant nem
  // autentica (401 invalid_client); sem header nenhum e client_id solto no
  // corpo, funciona e devolve um refresh_token novo (rotação). Ver nota
  // igual em api/softcs-oauth.js.
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

  // Trava atômica via UPDATE condicional — funciona mesmo com o driver HTTP
  // sem sessão persistente, já que cada statement é atômico sozinho (ao
  // contrário de pg_advisory_lock, que precisa de conexão mantida). Sem
  // isso, duas chamadas concorrentes perto do vencimento (ex: os crons
  // known/descoberta caindo no mesmo instante) renovavam em paralelo com o
  // MESMO refresh_token — cada renovação bem-sucedida invalida o anterior
  // (rotação), então a que "perdia a corrida" gravava por cima um token já
  // obsoleto e quebrava a conexão de vez (invalid_grant na chamada seguinte
  // — foi exatamente isso que aconteceu ao vivo).
  const lockRows = await sql`
    update softcs_oauth_tokens
    set refreshing_since = now()
    where id = 1
      and (refreshing_since is null or refreshing_since < now() - interval '20 seconds')
    returning refresh_token
  `;

  if (lockRows.length === 0) {
    // Outra chamada já está renovando agora — espera ela terminar e usa o
    // que ela gravar, em vez de tentar renovar também.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const freshRows = await sql`select access_token from softcs_oauth_tokens where id = 1`;
    return freshRows[0].access_token;
  }

  try {
    const refreshed = await refreshAccessToken(lockRows[0].refresh_token);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

    await sql`
      update softcs_oauth_tokens
      set access_token = ${refreshed.access_token},
          refresh_token = ${refreshed.refresh_token ?? lockRows[0].refresh_token},
          expires_at = ${newExpiresAt},
          refreshing_since = null,
          updated_at = now()
      where id = 1
    `;

    return refreshed.access_token;
  } catch (err) {
    await sql`update softcs_oauth_tokens set refreshing_since = null where id = 1`;
    throw err;
  }
}

// Chamado ao final de cada ciclo (fase known do polling, ou a descoberta
// completa — ver api/poll-tickets.js e api/discover-tickets.js), sem pular
// nenhuma finalização — getValidAccessToken() só bate no endpoint de
// renovação de verdade quando o token está a <60s de expirar (senão
// devolve o access_token já em cache, é barato chamar toda vez). Como o
// token dura 900s, qualquer cron com intervalo de até ~14min sempre acha
// um token válido ou renova a tempo — chamar isso no fim de todo ciclo
// (em vez de só às vezes, como antes) garante essa margem mesmo se algum
// dos crons configurados (known/descoberta) falhar num ciclo específico e
// só o outro continuar rodando.
export async function renewTokenAtCycleEnd() {
  await getValidAccessToken().catch((err) => console.error('Falha ao renovar token no fim do ciclo:', err.message));
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
