import sql from '../lib/db.js';
import { getValidAccessToken, getClients, getClientTickets } from '../lib/softcs-api.js';

// A SoftCS não tem um "listar tickets de todos os clientes" — o endpoint é
// sempre /clients/{clientId}/tickets, então a gente pagina os clientes (até
// MAX_CLIENT_PAGES × 200, o limite máximo por página) e busca os tickets de
// cada um. TICKET_CONCURRENCY evita disparar centenas de chamadas de uma vez.
const CLIENT_PAGE_LIMIT = 200;
const MAX_CLIENT_PAGES = 5;
const TICKETS_PER_CLIENT = 200;
const TICKET_CONCURRENCY = 20;

// A API pagina como { data: [...], pagination: { hasMore, nextOffset } } (a
// doc menciona "items", mas o servidor real usa "data").
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

// A API pública não devolve o nome do estágio (só o stageId) — usa o rótulo
// salvo em /api/stage-labels se existir; senão mostra um nome genérico a
// partir do ID, pra pelo menos diferenciar as colunas até serem renomeadas.
function extractStage(ticket, stageLabels) {
  const stage = ticket.denormalizedStage ?? ticket.stage;
  const id = stage?.id ?? ticket.stageId ?? 'sem-estagio';
  const fallbackName = id === 'sem-estagio' ? 'Sem estágio' : `Coluna #${id.slice(-4)}`;
  return {
    id,
    name: stageLabels[id] ?? stage?.name ?? fallbackName,
    color: stage?.color ?? null,
    position: typeof stage?.position === 'number' ? stage.position : 999,
  };
}

async function fetchAllClients() {
  const clients = [];
  let offset = 0;

  for (let page = 0; page < MAX_CLIENT_PAGES; page++) {
    const response = await getClients(CLIENT_PAGE_LIMIT, offset);
    const items = extractItems(response);
    clients.push(...items);

    const pagination = response?.pagination;
    if (items.length < CLIENT_PAGE_LIMIT || !pagination?.hasMore) break;
    offset = pagination.nextOffset ?? offset + CLIENT_PAGE_LIMIT;
  }

  return clients;
}

// Roda `fn` sobre `items` com no máximo `limit` chamadas em paralelo por vez.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    // Verifica o token antes de disparar as chamadas em paralelo — assim um
    // token expirado vira um erro claro em vez de "0 tickets" sem explicação
    // (cada chamada abaixo engole erro individual pra não derrubar as outras).
    await getValidAccessToken();

    const clients = await fetchAllClients();
    const clientNameById = new Map(clients.map((c) => [c.id, c.name]));

    const stageLabelRows = await sql`select stage_id, label from stage_labels`;
    const stageLabels = Object.fromEntries(stageLabelRows.map((r) => [r.stage_id, r.label]));

    const ticketLists = await mapWithConcurrency(clients, TICKET_CONCURRENCY, (client) =>
      getClientTickets(client.id, TICKETS_PER_CLIENT, 0).catch((err) => {
        console.error(`Falha ao buscar tickets do cliente ${client.id}:`, err.message);
        return null;
      })
    );

    // Log (só no servidor, nunca na resposta pro navegador — pode conter dados
    // sensíveis embutidos) da primeira resposta não-nula, pra debugar formatos
    // inesperados via Vercel > Logs sem precisar expor nada no Network tab.
    const firstRaw = ticketLists.find((response) => response !== null);
    if (firstRaw) {
      console.log('Exemplo de resposta de /clients/{id}/tickets:', JSON.stringify(firstRaw).slice(0, 2000));
    }

    const tickets = [];
    const creatorsById = new Map();
    let hasNames = false;

    for (const ticketsResponse of ticketLists) {
      if (!ticketsResponse) continue;
      const items = extractItems(ticketsResponse);
      for (const ticket of items) {
        const creator = extractCreator(ticket);
        if (creator?.name) hasNames = true;
        if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);

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
          stage: extractStage(ticket, stageLabels),
        });
      }
    }

    tickets.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    res.status(200).json({
      tickets,
      creators: [...creatorsById.values()],
      clientsScanned: clients.length,
      hasNames,
      // Só pra debug quando vier vazio — nomes de cliente não são sensíveis.
      scannedClientNames: tickets.length === 0 ? clients.map((c) => c.name) : undefined,
    });
  } catch (error) {
    console.error('Erro buscando tickets na SoftCS:', error);
    res.status(500).json({ error: error.message });
  }
}
