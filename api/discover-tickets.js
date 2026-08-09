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

// A SoftCS não tem um "listar tickets de todos os clientes" — o endpoint é
// sempre /clients/{clientId}/tickets. Contas grandes têm milhares de
// clientes (testado: uma conta real tinha mais de 2000), então cada chamada
// escaneia UM lote de clientes (`offset`/`limit` na querystring) e diz se há
// mais — o front chama de novo sozinho, em loop, até acabar ou o usuário
// clicar em "Parar".
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
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

    const stageLabelRows = await sql`select stage_id, label from stage_labels`;
    const stageLabels = Object.fromEntries(stageLabelRows.map((r) => [r.stage_id, r.label]));

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
      const items = extractItems(ticketsResponse);
      for (const ticket of items) {
        if (ticket.closedAt) continue; // só tickets abertos

        const creator = extractCreator(ticket);
        if (creator?.name) hasNames = true;
        if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);

        tickets.push({
          id: ticket.id,
          publicId: ticket.publicId ?? null,
          title: ticket.title ?? '(sem título)',
          priority: ticket.priority ?? null,
          clientName: extractClientName(ticket, clientNameById),
          createdAt: ticket.createdAt ?? null,
          createdBy: creator,
          stage: extractStage(ticket, stageLabels),
        });
      }
    }

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
