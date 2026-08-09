import sql from './db.js';
import { getTelegramMention } from './agents.js';
import { broadcastTelegramMessage, escapeHtml } from './telegram.js';

const PRIORITY_LABELS = {
  P0: '🔴 P0 (crítico)',
  P1: '🟠 P1',
  P2: '🟡 P2',
  P3: '🟢 P3',
};

const TICKET_BASE_URL = 'https://admin.softcs.com.br/pt-br/tickets';

export async function getStageName(stageId) {
  if (!stageId) return null;
  const rows = await sql`select label from stage_labels where stage_id = ${stageId}`;
  return rows[0]?.label ?? null;
}

// Chats onde o criador do ticket é membro cadastrado — é ali que a @menção
// realmente notifica (Telegram só avisa quem está no grupo). Sem nenhum chat
// com esse membro, cai pra todos os chats ativos (sem mention funcional).
export async function getTargetChatIds(createdById) {
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

// Resolve @menção, nome do estágio e chat(s) alvo, e manda a notificação —
// usado tanto por api/webhook.js (se algum dia a SoftCS chamar de verdade)
// quanto por api/poll-tickets.js (varredura periódica, já que não há webhook
// de ticket disponível na plataforma).
export async function notifyTicketEvent({ kind, title, priority, publicId, clientName, stageId, createdById }) {
  const [mention, stageName, chatIds] = await Promise.all([
    getTelegramMention(createdById),
    getStageName(stageId),
    getTargetChatIds(createdById),
  ]);

  if (chatIds.length === 0) {
    console.warn('Nenhum chat ativo em telegram_chats — cadastre na aba Chats');
    return;
  }

  await broadcastTelegramMessage(chatIds, buildMessage({ kind, title, priority, publicId, clientName, stageName, mention }));
}
