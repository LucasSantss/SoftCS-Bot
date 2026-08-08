import sql from '../lib/db.js';
import { getTicket, getClient, getTelegramMention } from '../lib/softcs.js';
import { sendTelegramMessage, escapeHtml } from '../lib/telegram.js';

const PRIORITY_LABELS = {
  P0: '🔴 P0 (crítico)',
  P1: '🟠 P1',
  P2: '🟡 P2',
  P3: '🟢 P3',
};

// TODO: ajustar assim que soubermos o formato real do evento (ver painel
// Webhooks da SoftCS). Por ora assume um envelope no estilo
// { eventId, event, data: { id, mainClientId, ... } } e cai para buscar o
// ticket via API caso só venham os IDs.
function parseEvent(payload) {
  const eventId =
    payload.eventId ?? payload.id ?? payload.event_id ?? `${payload.event ?? 'unknown'}:${payload.data?.id ?? payload.ticketId ?? Date.now()}`;

  const eventType = payload.event ?? payload.type ?? 'unknown';

  const ticketId = payload.data?.id ?? payload.ticketId ?? payload.ticket?.id;
  const clientId =
    payload.data?.mainClientId ?? payload.clientId ?? payload.ticket?.mainClientId;

  return { eventId, eventType, ticketId, clientId, inlineTicket: payload.data ?? payload.ticket };
}

function isTicketCreatedEvent(eventType) {
  return /ticket.*creat/i.test(eventType);
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

function buildMessage({ ticket, client, mention }) {
  const priority = PRIORITY_LABELS[ticket.priority] ?? ticket.priority ?? '-';
  const lines = [
    `🎫 <b>Novo ticket</b>`,
    `<b>${escapeHtml(ticket.title)}</b>`,
    '',
    `Prioridade: ${priority}`,
    client ? `Cliente: ${escapeHtml(client.name ?? client.id)}` : null,
    ticket.publicId ? `ID: ${escapeHtml(ticket.publicId)}` : null,
    '',
    mention ? `Criado por: ${mention}` : 'Criado por: (sem mapeamento cadastrado)',
  ].filter(Boolean);

  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // TODO: trocar por validação real (header de assinatura HMAC ou secret)
  // assim que soubermos como a SoftCS autentica o request no painel de Webhooks.
  const expectedSecret = process.env.SOFTCS_WEBHOOK_SECRET;
  if (expectedSecret) {
    const receivedSecret = req.headers['x-softcs-secret'];
    if (receivedSecret !== expectedSecret) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  const payload = req.body;
  const { eventId, eventType, ticketId, clientId, inlineTicket } = parseEvent(payload);

  if (!isTicketCreatedEvent(eventType)) {
    // Evento que não nos interessa (ex: atualização). Responde 200 para a
    // SoftCS não ficar reenviando.
    res.status(200).json({ skipped: true, eventType });
    return;
  }

  if (await alreadyProcessed(eventId)) {
    res.status(200).json({ duplicate: true });
    return;
  }

  try {
    const ticket = inlineTicket?.title
      ? inlineTicket
      : await getTicket(clientId, ticketId);

    const client = clientId ? await getClient(clientId).catch(() => null) : null;
    const mention = await getTelegramMention(ticket.createdById);

    await sendTelegramMessage(buildMessage({ ticket, client, mention }));
    await markProcessed(eventId);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando webhook SoftCS:', error);
    res.status(500).json({ error: 'internal error' });
  }
}
