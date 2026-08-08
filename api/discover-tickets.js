import sql from '../lib/db.js';
import { getValidAccessToken, getClient, getClientTickets } from '../lib/softcs-api.js';

// Busca TODOS os tickets de um único cliente (não escaneia a conta inteira —
// contas grandes têm milhares de clientes e não existe um "listar tickets de
// todos" na API da SoftCS). Pagina dentro desse cliente até acabar.
const PAGE_LIMIT = 200;
const MAX_PAGES = 20; // até 4000 tickets de um cliente só, generoso o bastante

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

async function fetchAllTicketsForClient(clientId) {
  const tickets = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await getClientTickets(clientId, PAGE_LIMIT, offset);
    const items = extractItems(response);
    tickets.push(...items);

    const pagination = response?.pagination;
    if (items.length < PAGE_LIMIT || !pagination?.hasMore) break;
    offset = pagination.nextOffset ?? offset + PAGE_LIMIT;
  }

  return tickets;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const clientId = (req.query?.clientId ?? '').trim();
  if (!clientId) {
    res.status(400).json({ error: 'clientId é obrigatório — escolha um cliente na busca acima' });
    return;
  }

  try {
    await getValidAccessToken();

    const [client, rawTickets] = await Promise.all([
      getClient(clientId),
      fetchAllTicketsForClient(clientId),
    ]);

    if (rawTickets.length > 0) {
      console.log('Exemplo de ticket cru:', JSON.stringify(rawTickets[0]).slice(0, 2000));
    }

    const stageLabelRows = await sql`select stage_id, label from stage_labels`;
    const stageLabels = Object.fromEntries(stageLabelRows.map((r) => [r.stage_id, r.label]));

    const tickets = [];
    const creatorsById = new Map();
    let hasNames = false;

    for (const ticket of rawTickets) {
      const creator = extractCreator(ticket);
      if (creator?.name) hasNames = true;
      if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);

      tickets.push({
        id: ticket.id,
        publicId: ticket.publicId ?? null,
        title: ticket.title ?? '(sem título)',
        priority: ticket.priority ?? null,
        clientName: ticket.denormalizedMainClient?.name ?? ticket.mainClient?.name ?? client.name ?? null,
        createdAt: ticket.createdAt ?? null,
        createdBy: creator,
        stage: extractStage(ticket, stageLabels),
      });
    }

    res.status(200).json({
      clientName: client.name,
      tickets,
      creators: [...creatorsById.values()],
      hasNames,
    });
  } catch (error) {
    console.error('Erro buscando tickets na SoftCS:', error);
    res.status(500).json({ error: error.message });
  }
}
