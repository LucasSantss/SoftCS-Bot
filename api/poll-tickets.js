import sql from '../lib/db.js';
import { getValidAccessToken, getClients, getClientTickets, renewTokenAtCycleEnd } from '../lib/softcs-api.js';
import { processTicket, processClosedTicket, SEED_FLAG_KEY } from '../lib/ticket-notify.js';
import { getSetting, setSettings } from '../lib/settings.js';
import {
  CLIENT_PAGE_LIMIT,
  TICKETS_PER_CLIENT,
  TICKET_CONCURRENCY,
  extractItems,
  extractClientName,
  extractJourneyNames,
  mapWithConcurrency,
} from '../lib/ticket-scan.js';

const CURSOR_KEY = 'ticket_poll_cursor';

async function getStageLabels() {
  const rows = await sql`select stage_id, label, position, is_closed_stage from stage_labels`;
  return Object.fromEntries(
    rows.map((r) => [r.stage_id, { label: r.label, position: r.position, is_closed_stage: r.is_closed_stage }])
  );
}

// Processa a lista de tickets já buscada, em paralelo (até TICKET_CONCURRENCY
// por vez) em vez de um por vez — cada ticket faz pelo menos um select +
// upsert no banco (ver processTicket/processClosedTicket em
// lib/ticket-notify.js), e isso sequencial some com dezenas de tickets
// (medido ao vivo: ~40s pra ~70 tickets conhecidos), estourando o timeout do
// cron externo (cron-job.org) mesmo com o handler dentro do limite da
// Vercel. Tickets são independentes entre si (ticket_id distinto cada um),
// sem corrida possível.
async function processTicketsConcurrently(tickets, { stageLabels, seeding, buildOpenArgs }) {
  const results = await mapWithConcurrency(tickets, TICKET_CONCURRENCY, async (ticket) => {
    if (stageLabels[ticket.stageId]?.is_closed_stage) {
      const result = await processClosedTicket(ticket, { stageLabels, seeding });
      return { open: false, notified: result.notified };
    }
    const result = await processTicket(ticket, { stageLabels, seeding, ...buildOpenArgs(ticket) });
    return { open: true, notified: result.notified };
  });

  let ticketsSeen = 0;
  let notified = 0;
  for (const r of results) {
    if (r.open) ticketsSeen += 1;
    if (r.notified) notified += 1;
  }
  return { ticketsSeen, notified };
}

// Fase prioritária: reconfirma só os clientes donos de tickets que JÁ estão
// em ticket_state, antes de gastar orçamento de requisição descobrindo
// tickets novos em clientes nunca vistos. Poucos clientes (um por ticket já
// conhecido, não a conta inteira), então roda inteira numa chamada só, sem
// paginação — garante que todo ciclo de 15min pelo menos reconfirma o que já
// sabemos, mesmo que a descoberta de tickets novos não complete a tempo do
// token expirar.
async function handleKnown(seeding) {
  const stageLabels = await getStageLabels();
  const knownClients = await sql`
    select distinct client_id from ticket_state where client_id is not null
  `;
  const clientIds = knownClients.map((r) => r.client_id);

  const ticketLists = await mapWithConcurrency(clientIds, TICKET_CONCURRENCY, (clientId) =>
    getClientTickets(clientId, TICKETS_PER_CLIENT, 0).catch((err) => {
      console.error(`Falha ao reconfirmar cliente conhecido ${clientId}:`, err.message);
      return null;
    })
  );
  const allTickets = ticketLists.flatMap((r) => (r ? extractItems(r) : []));

  const { ticketsSeen, notified } = await processTicketsConcurrently(allTickets, {
    stageLabels,
    seeding,
    buildOpenArgs: (ticket) => ({ clientName: extractClientName(ticket) }),
  });

  return { phase: 'known', knownClients: clientIds.length, ticketsSeen, notified };
}

// Fase de descoberta: varre a conta inteira em lotes (mesmo padrão de
// api/discover-tickets.js), retomando de onde parou (ver nota do cursor
// abaixo). É como tickets novos (em clientes ainda não vistos) são
// encontrados pela primeira vez.
async function handleDiscover(seeding, offset) {
  const stageLabels = await getStageLabels();

  const clientsResponse = await getClients(CLIENT_PAGE_LIMIT, offset);
  const clients = extractItems(clientsResponse);
  const clientNameById = new Map(clients.map((c) => [c.id, c.name]));
  const clientJourneyById = new Map(clients.map((c) => [c.id, extractJourneyNames(c)]));
  const clientPagination = clientsResponse?.pagination;

  const ticketLists = await mapWithConcurrency(clients, TICKET_CONCURRENCY, (client) =>
    getClientTickets(client.id, TICKETS_PER_CLIENT, 0).catch((err) => {
      console.error(`Falha ao buscar tickets do cliente ${client.id}:`, err.message);
      return null;
    })
  );
  const allTickets = ticketLists.flatMap((r) => (r ? extractItems(r) : []));

  const { ticketsSeen, notified } = await processTicketsConcurrently(allTickets, {
    stageLabels,
    seeding,
    buildOpenArgs: (ticket) => ({
      clientName: extractClientName(ticket, clientNameById),
      journeyNames: clientJourneyById.get(ticket.mainClientId) ?? null,
    }),
  });

  const hasMoreClients = Boolean(clientPagination?.hasMore);
  const nextOffset = clientPagination?.nextOffset ?? offset + clients.length;

  // Fim da conta: volta o cursor pro início pro próximo ciclo completo.
  // No meio: salva onde parou, pra retomar dali (mesma execução do GitHub
  // Actions ou, se essa falhar, a próxima).
  await setSettings({ [CURSOR_KEY]: String(hasMoreClients ? nextOffset : 0) });
  if (seeding && !hasMoreClients) {
    await setSettings({ [SEED_FLAG_KEY]: 'true' });
  }

  return { phase: 'discover', clientsScanned: clients.length, ticketsSeen, notified, hasMoreClients, nextOffset };
}

// Chamado pelo workflow do GitHub Actions (.github/workflows/poll-tickets.yml)
// a cada 15min, já que a SoftCS não expõe webhook de ticket (ver
// api/webhook.js). Duas fases, nessa ordem:
//
// 1. ?phase=known — reconfirma os clientes donos de tickets que já estão em
//    ticket_state. Roda primeiro e sempre inteira (poucos clientes), então
//    tickets já conhecidos têm sua movimentação detectada de forma
//    confiável todo ciclo, mesmo que a fase 2 nunca termine a tempo.
// 2. (padrão, sem phase) — descobre tickets novos varrendo a conta inteira
//    em lotes, retomando de onde parou (`ticket_poll_cursor` em `settings`)
//    em vez de sempre reiniciar do zero — importante porque, sem
//    refresh_token, o access_token expira no meio de uma varredura grande, e
//    sem esse cursor os clientes depois do ponto de queda nunca seriam
//    re-checados em ciclo nenhum. `?offset=` na query ainda funciona como
//    override manual pra debug.
//
// Na primeíssima varredura depois de configurado, ticket_state está vazio —
// sem o "modo seed", TODOS os tickets abertos da conta disparariam
// notificação de "criado" de uma vez, inundando os chats. Enquanto a flag
// `ticket_poll_seeded` não estiver marcada, as duas fases só gravam o
// snapshot, sem notificar; a flag é marcada quando uma volta completa da
// fase de descoberta termina.
//
// Além dessas duas chamadas programadas, toda chamada da fase "known" que
// pegar o access_token perto de expirar (<60s, ver REFRESH_MARGIN_MS em
// lib/softcs-api.js) e renovar de verdade também dispara, na mesma
// resposta, uma página extra de descoberta (`discoveryOnTokenRefresh` no
// JSON de retorno) — como o token dura 900s, isso acontece por volta de
// uma em cada ~7-14 chamadas da fase known (que roda de 1-2 em 1-2min),
// então tickets novos são descobertos amarrados à renovação de verdade do
// token, sem depender só do intervalo fixo do job de descoberta do cron
// externo (pedido explícito).
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization ?? '';
  if (!secret || authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'não autorizado' });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    await getValidAccessToken();

    const seeding = (await getSetting(SEED_FLAG_KEY)) !== 'true';
    const phase = req.query?.phase === 'known' ? 'known' : 'discover';

    const result =
      phase === 'known'
        ? await handleKnown(seeding)
        : await handleDiscover(
            seeding,
            req.query?.offset !== undefined
              ? Number.parseInt(req.query.offset, 10) || 0
              : Number.parseInt(await getSetting(CURSOR_KEY), 10) || 0
          );

    // Garante o token renovado no fim de cada finalização, sem pular
    // nenhuma — ver renewTokenAtCycleEnd em lib/softcs-api.js. Quando essa
    // renovação é de verdade (não um cache-hit) e essa chamada era só a
    // fase "known" (a rápida, chamada de 1-2 em 1-2min pelo cron externo),
    // aproveita o evento pra também avançar uma página de descoberta de
    // tickets novos — tickets novos passam a ser vistos no momento em que
    // o token renova de verdade (~14min, duração real dele), em vez de só
    // no intervalo fixo do outro job do cron externo.
    const refreshed = await renewTokenAtCycleEnd();
    let discoveryOnTokenRefresh = null;
    if (refreshed && phase === 'known') {
      const offset = Number.parseInt(await getSetting(CURSOR_KEY), 10) || 0;
      discoveryOnTokenRefresh = await handleDiscover(seeding, offset);
    }

    res.status(200).json({ seeding, ...result, ...(discoveryOnTokenRefresh ? { discoveryOnTokenRefresh } : {}) });
  } catch (error) {
    console.error('Erro no polling de tickets:', error);
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
