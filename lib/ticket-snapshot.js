import sql from './db.js';
import { searchAllTickets } from './softcs-api.js';
import { getSettings, setSettings } from './settings.js';
import { resolveClientNames } from './client-names.js';

// Mantém ticket_snapshot (ver schema.sql) = todos os tickets da conta, pra
// exportação (lib/export-tickets.js) responder sem chamar a SoftCS.
//
// Incremental: a cada rodada do polling busca só os tickets com updatedAt
// depois do cursor (normalmente 1 chamada). `after` é estrito (confirmado
// ao vivo), e o cursor recua CURSOR_OVERLAP_MS pra não perder um ticket
// gravado na SoftCS um instante depois da busca anterior — regravar o mesmo
// ticket é inofensivo (upsert).
//
// Completa (~11 chamadas): na primeira vez e depois a cada
// FULL_SYNC_INTERVAL_MS — é o único jeito de perceber ticket EXCLUÍDO na
// SoftCS (some da busca em vez de aparecer como atualizado).
const CURSOR_KEY = 'ticket_snapshot_cursor';
const FULL_AT_KEY = 'ticket_snapshot_full_at';
export const SYNCED_AT_KEY = 'ticket_snapshot_synced_at';
const FULL_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const UPSERT_CHUNK = 200;

// Descrição vem da API como { html } (1,5 MB somando a conta inteira) — vai
// como texto puro e cortada, que é só o que a busca textual de quem consome
// precisa.
const DESCRIPTION_MAX_CHARS = 1000;

// Alguns tickets antigos não têm mainClientId — usa o primeiro de clientIds
// quando houver (confirmado ao vivo: dos 33 sem principal, só 1 tinha).
export const clientIdOf = (t) => t.mainClientId ?? t.clientIds?.[0] ?? null;

function descriptionText(description) {
  const html = typeof description === 'string' ? description : description?.html;
  if (!html) return '';
  const text = html
    .replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return text.length > DESCRIPTION_MAX_CHARS ? `${text.slice(0, DESCRIPTION_MAX_CHARS)}…` : text;
}

async function upsertTickets(tickets) {
  for (let i = 0; i < tickets.length; i += UPSERT_CHUNK) {
    const chunk = tickets.slice(i, i + UPSERT_CHUNK);
    await sql`
      insert into ticket_snapshot (ticket_id, data, softcs_updated_at)
      select * from unnest(
        ${chunk.map((t) => t.id)}::text[],
        ${chunk.map((t) => JSON.stringify({ ...t, description: descriptionText(t.description) }))}::text[]::jsonb[],
        ${chunk.map((t) => t.updatedAt ?? null)}::timestamptz[]
      )
      on conflict (ticket_id) do update set
        data = excluded.data,
        softcs_updated_at = excluded.softcs_updated_at,
        synced_at = now()
    `;
  }
}

export async function isSnapshotEmpty() {
  const rows = await sql`select 1 from ticket_snapshot limit 1`;
  return rows.length === 0;
}

// Atualiza ticket_snapshot (incremental, ou completa quando vencida/`full`).
// Precisa de access_token válido — quem chama garante (getValidAccessToken).
export async function refreshSnapshot({ full: forceFull = false } = {}) {
  const startedAt = new Date().toISOString();
  const settings = await getSettings();
  const cursor = settings[CURSOR_KEY];
  const fullAt = settings[FULL_AT_KEY];
  const full = forceFull || !cursor || !fullAt || Date.now() - Date.parse(fullAt) > FULL_SYNC_INTERVAL_MS;

  const tickets = full
    ? await searchAllTickets({})
    : await searchAllTickets({
        filterGroups: [
          {
            filters: [
              {
                field: 'updatedAt',
                operator: 'after',
                value: new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString(),
              },
            ],
          },
        ],
      });

  await upsertTickets(tickets);

  // Só apaga com uma busca completa NÃO vazia — uma resposta vazia por
  // falha da API não pode zerar a cópia.
  let removed = 0;
  if (full && tickets.length > 0) {
    const deleted = await sql`
      delete from ticket_snapshot where not (ticket_id = any(${tickets.map((t) => t.id)})) returning ticket_id
    `;
    removed = deleted.length;
  }

  // Deixa o nome do cliente dos tickets que mudaram já em cache, pra
  // exportação não precisar buscar nada na SoftCS.
  try {
    await resolveClientNames(tickets.map(clientIdOf));
  } catch (err) {
    console.error('Falha ao aquecer cache de nomes de cliente:', err.message);
  }

  const maxUpdatedAt = tickets.reduce((m, t) => (t.updatedAt && t.updatedAt > m ? t.updatedAt : m), cursor ?? '');
  await setSettings({
    ...(maxUpdatedAt ? { [CURSOR_KEY]: maxUpdatedAt } : {}),
    [SYNCED_AT_KEY]: startedAt,
    ...(full ? { [FULL_AT_KEY]: startedAt } : {}),
  });

  return { mode: full ? 'full' : 'incremental', fetched: tickets.length, removed };
}
