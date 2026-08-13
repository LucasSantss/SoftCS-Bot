import sql from '../lib/db.js';
import { getValidAccessToken, getClients, getClientTickets, renewTokenAtCycleEnd } from '../lib/softcs-api.js';
import { requireSession } from '../lib/auth.js';
import { processTicket, processClosedTicket, SEED_FLAG_KEY } from '../lib/ticket-notify.js';
import { getSetting, setSettings } from '../lib/settings.js';
import {
  CLIENT_PAGE_LIMIT,
  TICKETS_PER_CLIENT,
  TICKET_CONCURRENCY,
  extractItems,
  extractCreator,
  extractClientName,
  mapWithConcurrency,
} from '../lib/ticket-scan.js';

async function getStageLabels() {
  const rows = await sql`select stage_id, label, position, is_closed_stage from stage_labels`;
  return Object.fromEntries(
    rows.map((r) => [r.stage_id, { label: r.label, position: r.position, is_closed_stage: r.is_closed_stage }])
  );
}

// Processa um ticket aberto encontrado ao vivo: grava/compara em
// ticket_state e notifica se mudou (mesma lógica do polling automático, via
// processTicket() em lib/ticket-notify.js — a busca manual "Buscar tickets"
// não é só um preview, ela também alimenta e dispara notificação igual ao
// polling), e monta o objeto de exibição pro Kanban com o stage já resolvido.
async function processAndBuildEntry(ticket, { stageLabels, clientNameById, seeding }) {
  const creator = extractCreator(ticket);
  const { stage, notified } = await processTicket(ticket, {
    stageLabels,
    clientName: extractClientName(ticket, clientNameById),
    seeding,
  });

  return {
    entry: {
      id: ticket.id,
      publicId: ticket.publicId ?? null,
      title: ticket.title ?? '(sem título)',
      priority: ticket.priority ?? null,
      clientName: extractClientName(ticket, clientNameById),
      createdAt: ticket.createdAt ?? null,
      createdBy: creator,
      stage,
    },
    creator,
    notified,
  };
}

// A SoftCS não tem um "listar tickets de todos os clientes" — o endpoint é
// sempre /clients/{clientId}/tickets. Contas grandes têm milhares de
// clientes (testado: uma conta real tinha mais de 2000), então cada chamada
// escaneia UM lote de clientes (`offset`/`limit` na querystring) e diz se há
// mais — o front chama de novo sozinho, em loop, até acabar ou o usuário
// clicar em "Parar".
//
// ?source=stored lê o Kanban salvo em ticket_state (mantido pelo polling em
// api/poll-tickets.js) em vez de escanear a SoftCS ao vivo — é o que o
// painel carrega sozinho ao abrir a página, pra o board ficar disponível na
// hora e só mudar quando o polling realmente detectar algo, sem precisar
// clicar em "Buscar tickets" toda vez que a página recarrega.
//
// ?phase=known reconfirma AO VIVO só os clientes donos de tickets que já
// estão em ticket_state — mesma prioridade que api/poll-tickets.js usa
// (ver nota lá). admin.js chama isso primeiro, antes de começar a loop de
// descoberta padrão, pra garantir que os tickets já conhecidos aparecem e
// se atualizam primeiro no Kanban, não só depois de escanear a conta
// inteira.
//
// Tanto a fase known quanto a descoberta padrão gravam em ticket_state e
// notificam via processTicket() — igual ao polling automático. Assim, um
// clique manual em "Buscar tickets" também conta como detecção de mudança,
// não só o polling agendado (importante enquanto o access_token da SoftCS
// não tiver refresh_token: o polling automático nem sempre roda a tempo).
async function handleKnown(req, res) {
  await getValidAccessToken();
  const stageLabels = await getStageLabels();
  const seeding = (await getSetting(SEED_FLAG_KEY)) !== 'true';

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

  const tickets = [];
  const creatorsById = new Map();
  let hasNames = false;
  let notified = 0;

  for (const ticketsResponse of ticketLists) {
    if (!ticketsResponse) continue;
    for (const ticket of extractItems(ticketsResponse)) {
      if (stageLabels[ticket.stageId]?.is_closed_stage) {
        const result = await processClosedTicket(ticket, { stageLabels, seeding });
        if (result.notified) notified += 1;
        continue;
      }
      const { entry, creator, notified: didNotify } = await processAndBuildEntry(ticket, {
        stageLabels,
        clientNameById: undefined,
        seeding,
      });
      if (creator?.name) hasNames = true;
      if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);
      if (didNotify) notified += 1;
      tickets.push(entry);
    }
  }

  // Garante o token renovado no fim de cada finalização, sem pular nenhuma
  // — ver renewTokenAtCycleEnd em lib/softcs-api.js.
  await renewTokenAtCycleEnd();

  res.status(200).json({
    tickets,
    creators: [...creatorsById.values()],
    clientsScanned: clientIds.length,
    hasNames,
    hasMoreClients: false,
    nextOffset: null,
    notified,
    known: true,
  });
}

async function handleStored(req, res) {
  const rows = await sql`
    select
      ts.ticket_id, ts.public_id, ts.stage_id, ts.title, ts.priority, ts.client_name,
      ts.created_by_id, ts.updated_at,
      sl.label as stage_label, sl.position as stage_position,
      am.display_name as creator_name, am.email as creator_email
    from ticket_state ts
    left join stage_labels sl on sl.stage_id = ts.stage_id
    left join agent_mapping am on am.softcs_user_id = ts.created_by_id
    order by ts.updated_at desc
  `;

  const creatorsById = new Map();
  const tickets = rows.map((r) => {
    const createdBy = r.created_by_id
      ? { id: r.created_by_id, name: r.creator_name ?? null, email: r.creator_email ?? null }
      : null;
    if (createdBy && !creatorsById.has(createdBy.id)) creatorsById.set(createdBy.id, createdBy);

    return {
      id: r.ticket_id,
      publicId: r.public_id,
      title: r.title ?? '(sem título)',
      priority: r.priority,
      clientName: r.client_name,
      createdAt: null,
      createdBy,
      stage: {
        id: r.stage_id ?? 'sem-estagio',
        name: r.stage_label ?? (r.stage_id ? `Coluna #${r.stage_id.slice(-4)}` : 'Sem estágio'),
        color: null,
        position: typeof r.stage_position === 'number' ? r.stage_position : 999,
      },
    };
  });

  res.status(200).json({
    tickets,
    creators: [...creatorsById.values()],
    clientsScanned: null,
    hasNames: tickets.some((t) => t.createdBy?.name),
    hasMoreClients: false,
    nextOffset: null,
    stored: true,
  });
}

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (req.query.source === 'stored') {
    try {
      await handleStored(req, res);
    } catch (error) {
      console.error('Erro lendo o Kanban salvo:', error);
      res.status(500).json({ error: error.message });
    }
    return;
  }

  if (req.query.phase === 'known') {
    try {
      await handleKnown(req, res);
    } catch (error) {
      console.error('Erro reconfirmando tickets conhecidos:', error);
      if (error.rateLimited) {
        res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
        return;
      }
      res.status(500).json({ error: error.message });
    }
    return;
  }

  const offset = Number.parseInt(req.query?.offset, 10) || 0;

  try {
    // Verifica o token antes de disparar as chamadas em paralelo — assim um
    // token expirado vira um erro claro em vez de "0 tickets" sem explicação.
    await getValidAccessToken();

    const seeding = (await getSetting(SEED_FLAG_KEY)) !== 'true';

    const clientsResponse = await getClients(CLIENT_PAGE_LIMIT, offset);
    const clients = extractItems(clientsResponse);
    const clientNameById = new Map(clients.map((c) => [c.id, c.name]));
    const clientPagination = clientsResponse?.pagination;

    const stageLabels = await getStageLabels();

    const ticketLists = await mapWithConcurrency(clients, TICKET_CONCURRENCY, (client) =>
      getClientTickets(client.id, TICKETS_PER_CLIENT, 0).catch((err) => {
        console.error(`Falha ao buscar tickets do cliente ${client.id}:`, err.message);
        return null;
      })
    );

    const tickets = [];
    const creatorsById = new Map();
    let hasNames = false;
    let notified = 0;

    for (const ticketsResponse of ticketLists) {
      if (!ticketsResponse) continue;
      for (const ticket of extractItems(ticketsResponse)) {
        if (stageLabels[ticket.stageId]?.is_closed_stage) {
          const result = await processClosedTicket(ticket, { stageLabels, seeding });
          if (result.notified) notified += 1;
          continue;
        }
        const { entry, creator, notified: didNotify } = await processAndBuildEntry(ticket, {
          stageLabels,
          clientNameById,
          seeding,
        });
        if (creator?.name) hasNames = true;
        if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);
        if (didNotify) notified += 1;
        tickets.push(entry);
      }
    }

    const hasMoreClients = Boolean(clientPagination?.hasMore);

    // Se uma varredura manual completar uma volta inteira enquanto ainda em
    // modo seed, conta como a primeira varredura completa também — mesma
    // regra do polling automático (ver api/poll-tickets.js).
    if (seeding && !hasMoreClients) {
      await setSettings({ [SEED_FLAG_KEY]: 'true' });
    }

    // Garante o token renovado no fim de cada finalização, sem pular
    // nenhuma — ver renewTokenAtCycleEnd em lib/softcs-api.js.
    await renewTokenAtCycleEnd();

    res.status(200).json({
      tickets,
      creators: [...creatorsById.values()],
      clientsScanned: clients.length,
      hasNames,
      hasMoreClients,
      nextOffset: clientPagination?.nextOffset ?? offset + clients.length,
      notified,
    });
  } catch (error) {
    console.error('Erro buscando tickets na SoftCS:', error);
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
