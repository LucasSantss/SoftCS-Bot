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

// A API pública (a que a gente usa — /clients/{id}/tickets, autenticada via
// OAuth) não devolve nome nem posição do estágio, só o stageId — confirmado
// ao vivo, `ticket.denormalizedStage`/`ticket.stage` vêm sempre `undefined`
// nela. Só o endpoint interno da SoftCS (sessão logada no navegador, fora do
// nosso alcance) devolve isso — daí `stageLabels`, alimentado manualmente
// (clique no nome da coluna na aba Tickets) ou por import pontual desses
// payloads internos quando o usuário cola um. Sem label salvo, cai no nome
// genérico a partir do ID e vai pro fim da ordem, só pra diferenciar as
// colunas até serem configuradas. `stageLabels` é um mapa
// stage_id -> { label, position, is_closed_stage }.
export function extractStage(ticket, stageLabels) {
  const stage = ticket.denormalizedStage ?? ticket.stage;
  const id = stage?.id ?? ticket.stageId ?? 'sem-estagio';
  const saved = stageLabels[id];
  const fallbackName = id === 'sem-estagio' ? 'Sem estágio' : `Coluna #${id.slice(-4)}`;
  return {
    id,
    name: saved?.label ?? stage?.name ?? fallbackName,
    color: stage?.color ?? null,
    position: typeof saved?.position === 'number' ? saved.position : typeof stage?.position === 'number' ? stage.position : 999,
    isClosedStage: saved?.is_closed_stage === true,
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

// Diferente do estágio do ticket, a API pública já devolve o nome da
// jornada pronto (`client.journeys[].journeyName`) — sem precisar de mapa
// manual tipo stage_labels. Um cliente pode estar em mais de uma jornada ao
// mesmo tempo (raro, mas visto ao vivo), daí devolver todas, sem repetir.
// `null` quando o cliente não está em nenhuma (não é um array vazio, pra
// distinguir de "sabemos que não tem" — ver processTicket em
// lib/ticket-notify.js, que preserva o valor salvo quando não vier nada).
export function extractJourneyNames(client) {
  const journeys = client?.journeys;
  if (!Array.isArray(journeys) || journeys.length === 0) return null;
  const names = [...new Set(journeys.map((j) => j.journeyName).filter(Boolean))];
  return names.length > 0 ? names : null;
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
