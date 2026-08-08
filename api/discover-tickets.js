import { getValidAccessToken, getClients, getClientTickets } from '../lib/softcs-api.js';

// Limite pra não estourar o tempo da function: só olha os N primeiros
// clientes retornados (cada um com até 50 tickets). Dá pra aumentar depois se
// precisar cobrir mais clientes de uma vez.
const MAX_CLIENTS = 30;

// A API pagina como { data: [...] } (a doc menciona "items", mas o servidor
// real usa "data" — confirmado inspecionando a resposta).
function extractItems(response) {
  if (Array.isArray(response)) return response;
  return response.data ?? response.items ?? [];
}

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
    // Verifica o token antes de disparar as N chamadas em paralelo — assim um
    // token expirado vira um erro claro em vez de "0 tickets" sem explicação
    // (cada chamada abaixo engole erro individual pra não derrubar as outras).
    await getValidAccessToken();

    const clientsResponse = await getClients(MAX_CLIENTS, 0);
    const clients = extractItems(clientsResponse);
    const clientNameById = new Map(clients.map((c) => [c.id, c.name]));

    const ticketLists = await Promise.all(
      clients.map((client) =>
        getClientTickets(client.id, 50, 0).catch((err) => {
          console.error(`Falha ao buscar tickets do cliente ${client.id}:`, err.message);
          return null;
        })
      )
    );

    const tickets = [];
    let hasNames = false;

    for (const ticketsResponse of ticketLists) {
      if (!ticketsResponse) continue;
      const items = extractItems(ticketsResponse);
      for (const ticket of items) {
        const creator = extractCreator(ticket);
        if (creator?.name) hasNames = true;
        tickets.push({
          id: ticket.id,
          publicId: ticket.publicId ?? null,
          title: ticket.title ?? '(sem título)',
          priority: ticket.priority ?? null,
          clientName:
            ticket.denormalizedMainClient?.name ??
            ticket.mainClient?.name ??
            clientNameById.get(ticket.mainClientId) ??
            null,
          createdAt: ticket.createdAt ?? null,
          createdBy: creator,
        });
      }
    }

    tickets.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    res.status(200).json({
      tickets,
      clientsScanned: clients.length,
      hasNames,
    });
  } catch (error) {
    console.error('Erro buscando tickets na SoftCS:', error);
    res.status(500).json({ error: error.message });
  }
}
