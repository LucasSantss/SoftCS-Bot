import { getClients, getClientTickets } from '../lib/softcs-api.js';

// Limite pra não estourar o tempo da function: só olha os N primeiros
// clientes retornados (cada um com até 50 tickets). Dá pra aumentar depois se
// precisar cobrir mais clientes de uma vez.
const MAX_CLIENTS = 30;

function extractCreator(ticket) {
  const creator = ticket.createdBy;
  if (creator && typeof creator === 'object' && creator.id) {
    return { id: creator.id, name: creator.name || null, email: creator.email || null };
  }
  if (ticket.createdById) {
    return { id: ticket.createdById, name: null, email: null };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    const clientsResponse = await getClients(MAX_CLIENTS, 0);
    const clients = Array.isArray(clientsResponse) ? clientsResponse : clientsResponse.items ?? [];

    const ticketLists = await Promise.all(
      clients.map((client) => getClientTickets(client.id, 50, 0).catch(() => null))
    );

    const byId = new Map();
    let ticketsScanned = 0;
    let hasNames = false;

    for (const ticketsResponse of ticketLists) {
      if (!ticketsResponse) continue;
      const tickets = Array.isArray(ticketsResponse) ? ticketsResponse : ticketsResponse.items ?? [];
      for (const ticket of tickets) {
        ticketsScanned += 1;
        const creator = extractCreator(ticket);
        if (!creator) continue;
        if (creator.name) hasNames = true;
        if (!byId.has(creator.id)) byId.set(creator.id, creator);
      }
    }

    res.status(200).json({
      creators: [...byId.values()],
      clientsScanned: clients.length,
      ticketsScanned,
      hasNames,
    });
  } catch (error) {
    console.error('Erro buscando criadores na SoftCS:', error);
    res.status(500).json({ error: error.message });
  }
}
