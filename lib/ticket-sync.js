import sql from './db.js';
import { searchAllTickets, getClient } from './softcs-api.js';
import { processTicket, processClosedTicket } from './ticket-notify.js';
import { TICKET_CONCURRENCY, extractStage, extractJourneyNames, mapWithConcurrency } from './ticket-scan.js';

// Máximo de filterGroups aceito por /tickets/search — e `id` só aceita
// `equals`, então buscar N tickets por id = N grupos (OR), em lotes de 5.
const MAX_FILTER_GROUPS = 5;

// Ticket que some da lista de abertos com a última movimentação há mais
// que isso é resolução antiga (ex: linha órfã que a varredura por cliente
// antiga nunca reconfirmou) — sai do ticket_state sem notificar
// "resolvido" atrasado.
const STALE_CLOSE_MS = 24 * 60 * 60 * 1000;

export async function getStageLabels() {
  const rows = await sql`
    select stage_id, label, position, is_closed_stage, is_awaiting_response_stage from stage_labels
  `;
  return Object.fromEntries(
    rows.map((r) => [
      r.stage_id,
      {
        label: r.label,
        position: r.position,
        is_closed_stage: r.is_closed_stage,
        is_awaiting_response_stage: r.is_awaiting_response_stage,
      },
    ])
  );
}

// "Fechado" continua sendo decidido pela coluna (stage_labels.is_closed_stage)
// — confirmado ao vivo que "Resolvido por Inatividade" mantém status=OPEN na
// API. status CLOSED/CANCELLED também conta, pra um ticket fechado numa
// coluna ainda não marcada não ficar preso no Kanban de abertos.
function isClosed(ticket, stageLabels) {
  return stageLabels[ticket.stageId]?.is_closed_stage === true || (ticket.status != null && ticket.status !== 'OPEN');
}

async function getTicketsById(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += MAX_FILTER_GROUPS) chunks.push(ids.slice(i, i + MAX_FILTER_GROUPS));
  const results = await mapWithConcurrency(chunks, TICKET_CONCURRENCY, (chunk) =>
    searchAllTickets({
      filterGroups: chunk.map((id) => ({ filters: [{ field: 'id', operator: 'equals', value: id }] })),
    })
  );
  return results.flat();
}

// A busca de tickets não traz nome nem jornada do cliente, só o
// mainClientId — e /clients não aceita filtro por id, então é um GET por
// cliente. Falha em um cliente não derruba a sincronização: o ticket só
// fica com o nome/jornada já salvos em ticket_state.
async function getClientInfo(clientIds) {
  const entries = await mapWithConcurrency(clientIds, TICKET_CONCURRENCY, async (clientId) => {
    try {
      const client = await getClient(clientId);
      return [clientId, { name: client?.name ?? null, journeyNames: extractJourneyNames(client) }];
    } catch (err) {
      console.error(`Falha ao buscar cliente ${clientId}:`, err.message);
      return [clientId, null];
    }
  });
  return new Map(entries.filter(([, info]) => info));
}

// Sincroniza ticket_state com a SoftCS via POST /tickets/search (conta
// inteira, sem clientId — inclui clientes INACTIVE, que a varredura antiga
// por cliente pulava). Uma rodada completa:
//
// 1. Todos os tickets status=OPEN (~2 páginas) — pega ticket novo e
//    mudança de coluna, e os que caíram numa coluna de encerramento sem
//    mudar o status (ver isClosed).
// 2. Linhas do ticket_state que não vieram em (1) são buscadas pelo id:
//    fecharam/cancelaram (vira "resolvido") ou foram excluídas na SoftCS
//    (saem do ticket_state sem notificar).
//
// Nome/jornada do cliente só são buscados pros tickets que vão gravar algo
// novo (ticket ainda não visto, coluna mudou ou sem nome salvo) — o
// resto preserva o que já está em ticket_state (ver processTicket).
export async function syncTickets({ seeding }) {
  const [stageLabels, openTickets, stateRows] = await Promise.all([
    getStageLabels(),
    searchAllTickets({ filterGroups: [{ filters: [{ field: 'status', operator: 'equals', value: 'OPEN' }] }] }),
    sql`select ticket_id, stage_id, client_name from ticket_state`,
  ]);
  const stateById = new Map(stateRows.map((r) => [r.ticket_id, r]));
  const openIds = new Set(openTickets.map((t) => t.id));

  const clientIdsToFetch = new Set();
  for (const ticket of openTickets) {
    if (!ticket.mainClientId || isClosed(ticket, stageLabels)) continue;
    const previous = stateById.get(ticket.id);
    if (!previous || !previous.client_name || previous.stage_id !== extractStage(ticket, stageLabels).id) {
      clientIdsToFetch.add(ticket.mainClientId);
    }
  }

  const vanishedIds = stateRows.map((r) => r.ticket_id).filter((id) => !openIds.has(id));
  const [clientInfo, vanishedTickets] = await Promise.all([
    getClientInfo([...clientIdsToFetch]),
    getTicketsById(vanishedIds),
  ]);

  const foundIds = new Set(vanishedTickets.map((t) => t.id));
  const deletedIds = vanishedIds.filter((id) => !foundIds.has(id));
  if (deletedIds.length > 0) {
    await sql`delete from ticket_state where ticket_id = any(${deletedIds})`;
  }

  const results = await mapWithConcurrency([...openTickets, ...vanishedTickets], TICKET_CONCURRENCY, async (ticket) => {
    if (isClosed(ticket, stageLabels)) {
      const stale = Date.now() - new Date(ticket.updatedAt).getTime() > STALE_CLOSE_MS;
      const result = await processClosedTicket(ticket, { stageLabels, seeding: seeding || stale });
      return { open: false, notified: result.notified };
    }

    const client = clientInfo.get(ticket.mainClientId);
    const clientName = client?.name ?? stateById.get(ticket.id)?.client_name ?? null;
    const result = await processTicket(ticket, {
      stageLabels,
      clientName,
      journeyNames: client?.journeyNames ?? null,
      seeding,
    });
    return { open: true, notified: result.notified, ticket, stage: result.stage, clientName };
  });

  const open = results.filter((r) => r.open);
  return {
    open,
    stats: {
      openTickets: open.length,
      checkedById: vanishedIds.length,
      removedDeleted: deletedIds.length,
      clientsFetched: clientIdsToFetch.size,
      notified: results.filter((r) => r.notified).length,
    },
  };
}
