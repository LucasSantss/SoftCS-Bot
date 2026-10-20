import sql from './db.js';
import { getClient } from './softcs-api.js';
import { TICKET_CONCURRENCY, extractJourneyNames, mapWithConcurrency } from './ticket-scan.js';

// Quantos clientes buscar por chamada (sem nome em cache ou com cache
// vencido — ver client_names em schema.sql) — o resto vai nas próximas.
const CLIENT_NAME_BATCH = 100;

// Depois disso o cliente é buscado de novo: jornada e CSM mudam com o
// tempo, diferente do nome.
const CLIENT_INFO_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Grava em client_names o que um GET /clients/{id} devolveu — chamado daqui
// e da sincronização (lib/ticket-sync.js), que já busca o cliente de ticket
// novo ou que mudou de coluna. `infos` = [{ clientId, name, journeyNames, csm }].
export async function saveClientInfo(infos) {
  if (infos.length === 0) return;
  await sql`
    insert into client_names (client_id, name, journey_names, csm_id, csm_name, info_updated_at)
    select client_id, name, nullif(journey_names, '')::jsonb, csm_id, csm_name, now() from unnest(
      ${infos.map((i) => i.clientId)}::text[],
      ${infos.map((i) => i.name ?? null)}::text[],
      ${infos.map((i) => (i.journeyNames ? JSON.stringify(i.journeyNames) : ''))}::text[],
      ${infos.map((i) => i.csm?.id ?? null)}::text[],
      ${infos.map((i) => i.csm?.name ?? null)}::text[]
    ) as u(client_id, name, journey_names, csm_id, csm_name)
    on conflict (client_id) do update set
      name = excluded.name,
      journey_names = excluded.journey_names,
      csm_id = excluded.csm_id,
      csm_name = excluded.csm_name,
      info_updated_at = excluded.info_updated_at,
      updated_at = now()
  `;
}

// Nome de cada cliente, pra exibição: cache em client_names + ticket_state,
// e GET /clients/{id} (um por um — /clients não filtra por id) só pros que
// ainda faltam ou estão vencidos (CLIENT_INFO_MAX_AGE_MS), até
// CLIENT_NAME_BATCH por chamada — os sem nome primeiro. A busca de tickets
// não traz o nome e listar /clients inteiro custa ~44 chamadas, por isso o
// cache. Passe `clientIds` em ordem de prioridade. Com `fetchMissing: false`
// só lê o cache, sem chamar a SoftCS. Devolve { nameById, missing }.
export async function resolveClientNames(clientIds, { fetchMissing = true } = {}) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  const cached = await sql`
    select client_id, name, info_updated_at from client_names where client_id = any(${ids})
    union all
    select distinct on (client_id) client_id, client_name, null from ticket_state
    where client_id = any(${ids}) and client_name is not null
  `;
  const nameById = new Map(cached.map((r) => [r.client_id, r.name]));
  const freshIds = new Set(
    cached
      .filter((r) => r.info_updated_at && Date.now() - new Date(r.info_updated_at).getTime() < CLIENT_INFO_MAX_AGE_MS)
      .map((r) => r.client_id)
  );

  const toFetch = fetchMissing
    ? [...ids.filter((id) => !nameById.has(id)), ...ids.filter((id) => nameById.has(id) && !freshIds.has(id))].slice(
        0,
        CLIENT_NAME_BATCH
      )
    : [];
  const fetched = await mapWithConcurrency(toFetch, TICKET_CONCURRENCY, async (clientId) => {
    try {
      const client = await getClient(clientId);
      return {
        clientId,
        name: client?.name ?? null,
        journeyNames: extractJourneyNames(client),
        csm: client?.csm ? { id: client.csm.id ?? null, name: client.csm.name ?? null } : null,
      };
    } catch (err) {
      console.error(`Falha ao buscar cliente ${clientId}:`, err.message);
      return null;
    }
  });

  const found = fetched.filter(Boolean);
  for (const f of found) nameById.set(f.clientId, f.name);
  await saveClientInfo(found);

  return { nameById, missing: ids.filter((id) => !nameById.has(id)).length };
}
