// Helpers compartilhados por quem varre tickets em lote pela API da SoftCS
// (api/discover-tickets.js, pro Kanban da aba Tickets, e api/poll-tickets.js,
// pro polling que dispara notificação no Telegram). A SoftCS não tem um
// "listar tickets de todos os clientes" — o endpoint é sempre
// /clients/{clientId}/tickets — então os dois escaneiam em lotes de clientes
// (offset/limit), um lote por chamada.
export const CLIENT_PAGE_LIMIT = 200;
export const TICKETS_PER_CLIENT = 200;
export const TICKET_CONCURRENCY = 20;

// A API pagina como { data: [...], pagination: { hasMore, nextOffset } } (a
// doc menciona "items", mas o servidor real usa "data").
export function extractItems(response) {
  if (Array.isArray(response)) return response;
  return response.data ?? response.items ?? [];
}

export function extractCreator(ticket) {
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
export function extractStage(ticket, stageLabels) {
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

export function extractClientName(ticket, clientNameById) {
  return (
    ticket.denormalizedMainClient?.name ??
    ticket.mainClient?.name ??
    clientNameById?.get(ticket.mainClientId) ??
    null
  );
}

// Roda `fn` sobre `items` com no máximo `limit` chamadas em paralelo por vez.
export async function mapWithConcurrency(items, limit, fn) {
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
