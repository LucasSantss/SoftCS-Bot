import sql from '../lib/db.js';
import { notifyTicketEvent } from '../lib/ticket-notify.js';

// TODO: ajustar assim que soubermos o formato real do payload (ver painel
// Webhooks da SoftCS, ou disparar um evento de teste e olhar os logs da
// Vercel). Por ora assume um envelope no estilo { event, eventId, data: {...} }
// com o ticket já embutido — sem nenhuma chamada de volta pra API da SoftCS.
//
// Pendência maior: até onde investigamos, a SoftCS não expõe webhook de
// ticket em lugar nenhum do self-service (a aba Automações só dispara pra
// eventos de Cliente, com ações fixas — nenhuma delas chama uma URL
// externa). Por isso a notificação real hoje vem do polling em
// api/poll-tickets.js, não daqui. Esse endpoint continua de pé (e não exige
// sessão, já que seria chamado pela SoftCS, não por um navegador logado)
// pro caso de existir webhook liberado sob pedido ao suporte, ou se a SoftCS
// vier a lançar isso no futuro.
function parsePayload(payload) {
  const ticket = payload.data ?? payload.ticket ?? payload;

  return {
    eventId: payload.eventId ?? payload.id ?? ticket.id ?? `${payload.event ?? 'evt'}:${Date.now()}`,
    eventType: payload.event ?? payload.type ?? 'unknown',
    title: ticket.title,
    priority: ticket.priority,
    publicId: ticket.publicId,
    stageId: ticket.stageId ?? ticket.stage?.id ?? null,
    clientName: ticket.client?.name ?? ticket.mainClient?.name ?? ticket.clientName ?? null,
    createdById: ticket.createdById ?? ticket.createdBy?.id ?? null,
  };
}

function classifyEvent(eventType) {
  if (/creat/i.test(eventType)) return 'created';
  if (/updat|chang|mov/i.test(eventType)) return 'updated';
  return null;
}

async function alreadyProcessed(eventId) {
  const rows = await sql`select 1 from processed_webhook_events where event_id = ${eventId}`;
  return rows.length > 0;
}

async function markProcessed(eventId) {
  await sql`
    insert into processed_webhook_events (event_id) values (${eventId})
    on conflict (event_id) do nothing
  `;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const payload = req.body ?? {};
  const { eventId, eventType, title, priority, publicId, stageId, clientName, createdById } = parsePayload(payload);

  const kind = classifyEvent(eventType);
  if (!kind) {
    // Evento que não nos interessa. Responde 200 para a SoftCS não ficar reenviando.
    res.status(200).json({ skipped: true, eventType });
    return;
  }

  if (await alreadyProcessed(eventId)) {
    res.status(200).json({ duplicate: true });
    return;
  }

  try {
    await notifyTicketEvent({ kind, title, priority, publicId, clientName, stageId, createdById });
    await markProcessed(eventId);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando webhook SoftCS:', error);
    res.status(500).json({ error: 'internal error' });
  }
}
