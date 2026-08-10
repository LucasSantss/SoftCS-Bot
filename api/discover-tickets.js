import sql from '../lib/db.js';
import { getValidAccessToken, getClients, getClientTickets } from '../lib/softcs-api.js';
import { requireSession } from '../lib/auth.js';
import {
  CLIENT_PAGE_LIMIT,
  TICKETS_PER_CLIENT,
  TICKET_CONCURRENCY,
  extractItems,
  extractCreator,
  extractStage,
  extractClientName,
  mapWithConcurrency,
} from '../lib/ticket-scan.js';

async function getStageLabels() {
  const rows = await sql`select stage_id, label, position from stage_labels`;
  return Object.fromEntries(rows.map((r) => [r.stage_id, { label: r.label, position: r.position }]));
}

// Monta o objeto de exibição de um ticket (pro Kanban) + extrai o criador —
// usado tanto pela fase known quanto pela descoberta ao vivo.
function buildTicketEntry(ticket, { stageLabels, clientNameById }) {
  return {
    ticket: {
      id: ticket.id,
      publicId: ticket.publicId ?? null,
      title: ticket.title ?? '(sem título)',
      priority: ticket.priority ?? null,
      clientName: extractClientName(ticket, clientNameById),
      createdAt: ticket.createdAt ?? null,
      createdBy: extractCreator(ticket),
      stage: extractStage(ticket, stageLabels),
    },
    creator: extractCreator(ticket),
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
// inteira. Não notifica nada (isso é só pra exibição no painel) — quem
// notifica é sempre o polling.
async function handleKnown(req, res) {
  await getValidAccessToken();
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

  const tickets = [];
  const creatorsById = new Map();
  let hasNames = false;

  for (const ticketsResponse of ticketLists) {
    if (!ticketsResponse) continue;
    for (const ticket of extractItems(ticketsResponse)) {
      if (ticket.closedAt) continue; // só tickets abertos
      const { ticket: entry, creator } = buildTicketEntry(ticket, { stageLabels, clientNameById: undefined });
      if (creator?.name) hasNames = true;
      if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);
      tickets.push(entry);
    }
  }

  res.status(200).json({
    tickets,
    creators: [...creatorsById.values()],
    clientsScanned: clientIds.length,
    hasNames,
    hasMoreClients: false,
    nextOffset: null,
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

    for (const ticketsResponse of ticketLists) {
      if (!ticketsResponse) continue;
      for (const ticket of extractItems(ticketsResponse)) {
        if (ticket.closedAt) continue; // só tickets abertos
        const { ticket: entry, creator } = buildTicketEntry(ticket, { stageLabels, clientNameById });
        if (creator?.name) hasNames = true;
        if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);
        tickets.push(entry);
      }
    }

    // Renova o token de novo aqui no fim (além do início) — se a varredura
    // levou um tempo (ex: esperou rate limit), isso mantém o token o mais
    // fresco possível pra próxima chamada do loop, sem esperar ela precisar
    // disso pra só então renovar. getValidAccessToken() já checa a margem
    // de expiração sozinho, então isso não força uma renovação desnecessária.
    await getValidAccessToken().catch((err) => console.error('Falha ao renovar token no fim da busca:', err.message));

    res.status(200).json({
      tickets,
      creators: [...creatorsById.values()],
      clientsScanned: clients.length,
      hasNames,
      hasMoreClients: Boolean(clientPagination?.hasMore),
      nextOffset: clientPagination?.nextOffset ?? offset + clients.length,
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
