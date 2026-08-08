import sql from '../lib/db.js';
import { getTelegramMention } from '../lib/agents.js';
import { broadcastTelegramMessage, escapeHtml } from '../lib/telegram.js';

const PRIORITY_LABELS = {
  P0: '🔴 P0 (crítico)',
  P1: '🟠 P1',
  P2: '🟡 P2',
  P3: '🟢 P3',
};

// TODO: ajustar assim que soubermos o formato real do payload (ver painel
// Webhooks da SoftCS, ou disparar um evento de teste e olhar os logs da
// Vercel). Por ora assume um envelope no estilo { event, eventId, data: {...} }
// com o ticket já embutido — sem nenhuma chamada de volta pra API da SoftCS.
function parsePayload(payload) {
  const ticket = payload.data ?? payload.ticket ?? payload;

  return {
    eventId: payload.eventId ?? payload.id ?? ticket.id ?? `${payload.event ?? 'evt'}:${Date.now()}`,
    eventType: payload.event ?? payload.type ?? 'unknown',
    title: ticket.title,
    priority: ticket.priority,
    publicId: ticket.publicId,
    clientName: ticket.client?.name ?? ticket.mainClient?.name ?? ticket.clientName ?? null,
    createdById: ticket.createdById ?? ticket.createdBy?.id ?? null,
  };
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

async function getActiveChatIds() {
  const rows = await sql`select chat_id from telegram_chats where active = true`;
  return rows.map((row) => row.chat_id);
}

function buildMessage({ title, priority, publicId, clientName, mention }) {
  const priorityLabel = PRIORITY_LABELS[priority] ?? priority ?? '-';
  const lines = [
    `🎫 <b>Novo ticket</b>`,
    `<b>${escapeHtml(title ?? '(sem título)')}</b>`,
    '',
    `Prioridade: ${priorityLabel}`,
    clientName ? `Cliente: ${escapeHtml(clientName)}` : null,
    publicId ? `ID: ${escapeHtml(publicId)}` : null,
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

  const payload = req.body ?? {};
  const { eventId, eventType, title, priority, publicId, clientName, createdById } = parsePayload(payload);

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
    const mention = await getTelegramMention(createdById);
    const chatIds = await getActiveChatIds();

    if (chatIds.length > 0) {
      await broadcastTelegramMessage(chatIds, buildMessage({ title, priority, publicId, clientName, mention }));
    } else {
      console.warn('Nenhum chat ativo em telegram_chats — cadastre em /admin.html');
    }

    await markProcessed(eventId);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando webhook SoftCS:', error);
    res.status(500).json({ error: 'internal error' });
  }
}
