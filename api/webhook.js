import sql from '../lib/db.js';
import { getTelegramMention } from '../lib/agents.js';
import { broadcastTelegramMessage, escapeHtml } from '../lib/telegram.js';

const PRIORITY_LABELS = {
  P0: '🔴 P0 (crítico)',
  P1: '🟠 P1',
  P2: '🟡 P2',
  P3: '🟢 P3',
};

const TICKET_BASE_URL = 'https://admin.softcs.com.br/pt-br/tickets';

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

async function getStageName(stageId) {
  if (!stageId) return null;
  const rows = await sql`select label from stage_labels where stage_id = ${stageId}`;
  return rows[0]?.label ?? null;
}

// Chats onde o criador do ticket é membro cadastrado — é ali que a @menção
// realmente notifica (Telegram só avisa quem está no grupo). Sem nenhum chat
// com esse membro, cai pra todos os chats ativos (sem mention funcional).
async function getTargetChatIds(createdById) {
  if (createdById) {
    const rows = await sql`
      select c.chat_id
      from chat_agents a
      join telegram_chats c on c.chat_id = a.chat_id
      where a.softcs_user_id = ${createdById} and c.active = true
    `;
    if (rows.length > 0) return rows.map((r) => r.chat_id);
  }

  const rows = await sql`select chat_id from telegram_chats where active = true`;
  return rows.map((r) => r.chat_id);
}

function buildMessage({ kind, title, priority, publicId, clientName, stageName, mention }) {
  const priorityLabel = PRIORITY_LABELS[priority] ?? priority ?? '-';
  const link = publicId ? `${TICKET_BASE_URL}/${publicId}` : null;
  const heading = kind === 'updated' ? '🔄 <b>Ticket atualizado</b>' : '🎫 <b>Novo ticket</b>';

  const lines = [
    heading,
    `<b>${escapeHtml(title ?? '(sem título)')}</b>`,
    '',
    stageName ? `Estágio: ${escapeHtml(stageName)}` : null,
    `Prioridade: ${priorityLabel}`,
    clientName ? `Cliente: ${escapeHtml(clientName)}` : null,
    '',
    mention ? `Criado por: ${mention}` : 'Criado por: (sem mapeamento cadastrado)',
    link ? `<a href="${link}">Ver ticket</a>` : null,
  ].filter(Boolean);

  return lines.join('\n');
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
    const [mention, stageName, chatIds] = await Promise.all([
      getTelegramMention(createdById),
      getStageName(stageId),
      getTargetChatIds(createdById),
    ]);

    if (chatIds.length > 0) {
      await broadcastTelegramMessage(
        chatIds,
        buildMessage({ kind, title, priority, publicId, clientName, stageName, mention })
      );
    } else {
      console.warn('Nenhum chat ativo em telegram_chats — cadastre na aba Chats');
    }

    await markProcessed(eventId);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando webhook SoftCS:', error);
    res.status(500).json({ error: 'internal error' });
  }
}
