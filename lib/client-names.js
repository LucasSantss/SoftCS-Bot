import sql from './db.js';
import { getClient } from './softcs-api.js';
import { TICKET_CONCURRENCY, mapWithConcurrency } from './ticket-scan.js';

// Quantos clientes sem nome em cache buscar por chamada (ver client_names
// em schema.sql) — o resto aparece nas próximas.
const CLIENT_NAME_BATCH = 100;

// Nome de cada cliente, pra exibição: cache em client_names + ticket_state,
// e GET /clients/{id} (um por um — /clients não filtra por id) só pros que
// ainda faltam, até CLIENT_NAME_BATCH por chamada. A busca de tickets não
// traz o nome e listar /clients inteiro custa ~44 chamadas, por isso o
// cache. Passe `clientIds` em ordem de prioridade (os primeiros que faltam
// são buscados primeiro). Com `fetchMissing: false` só lê o cache, sem
// chamar a SoftCS. Devolve { nameById, missing }.
export async function resolveClientNames(clientIds, { fetchMissing = true } = {}) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  const cached = await sql`
    select client_id, name from client_names where client_id = any(${ids})
    union all
    select distinct on (client_id) client_id, client_name from ticket_state
    where client_id = any(${ids}) and client_name is not null
  `;
  const nameById = new Map(cached.map((r) => [r.client_id, r.name]));

  const toFetch = fetchMissing ? ids.filter((id) => !nameById.has(id)).slice(0, CLIENT_NAME_BATCH) : [];
  const fetched = await mapWithConcurrency(toFetch, TICKET_CONCURRENCY, async (clientId) => {
    try {
      const client = await getClient(clientId);
      return { clientId, name: client?.name ?? null };
    } catch (err) {
      console.error(`Falha ao buscar cliente ${clientId}:`, err.message);
      return null;
    }
  });

  const found = fetched.filter(Boolean);
  for (const f of found) nameById.set(f.clientId, f.name);
  if (found.length > 0) {
    await sql`
      insert into client_names (client_id, name)
      select * from unnest(${found.map((f) => f.clientId)}::text[], ${found.map((f) => f.name)}::text[])
      on conflict (client_id) do update set name = excluded.name, updated_at = now()
    `;
  }

  return { nameById, missing: ids.filter((id) => !nameById.has(id)).length };
}
