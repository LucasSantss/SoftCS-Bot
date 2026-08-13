import sql from './db.js';
import { getTelegramMention } from './agents.js';
import { broadcastTelegramMessage, escapeHtml } from './telegram.js';
import { extractStage } from './ticket-scan.js';

const PRIORITY_LABELS = {
  P0: '🔴 P0 (crítico)',
  P1: '🟠 P1',
  P2: '🟡 P2',
  P3: '🟢 P3',
};

const TICKET_BASE_URL = 'https://admin.softcs.com.br/pt-br/tickets';

// Chave em `settings` que controla o "modo seed": enquanto não estiver
// 'true', qualquer chamador de processTicket() só grava o snapshot, sem
// notificar (ver processTicket abaixo).
export const SEED_FLAG_KEY = 'ticket_poll_seeded';

export async function getStageName(stageId) {
  if (!stageId) return null;
  const rows = await sql`select label from stage_labels where stage_id = ${stageId}`;
  return rows[0]?.label ?? null;
}

// Chats onde o criador do ticket é membro cadastrado — é ali que a @menção
// realmente notifica (Telegram só avisa quem está no grupo), e é assim
// também que uma inscrição pessoal via /status (ver api/telegram-webhook.js)
// passa a receber os tickets de quem se inscreveu: o chat privado da pessoa
// vira só mais uma linha em chat_agents. Sem nenhum chat com esse membro,
// cai pra todos os chats ativos (sem mention funcional). Cada item devolvido
// tem { chatId, threadId } — threadId vem de telegram_chats.thread_id
// quando o chat é um Tópico específico dentro de um grupo (ver aba Chats).
export async function getTargetChatIds(createdById) {
  if (createdById) {
    const rows = await sql`
      select c.chat_id, c.thread_id
      from chat_agents a
      join telegram_chats c on c.chat_id = a.chat_id
      where a.softcs_user_id = ${createdById} and c.active = true
    `;
    if (rows.length > 0) return rows.map((r) => ({ chatId: r.chat_id, threadId: r.thread_id }));
  }

  const rows = await sql`select chat_id, thread_id from telegram_chats where active = true`;
  return rows.map((r) => ({ chatId: r.chat_id, threadId: r.thread_id }));
}

const HEADINGS = {
  created: '🎫 <b>Novo ticket</b>',
  updated: '🔄 <b>Ticket atualizado</b>',
  closed: '✅ <b>Ticket resolvido</b>',
};

function buildMessage({ kind, title, priority, publicId, clientName, stageName, mention }) {
  const priorityLabel = PRIORITY_LABELS[priority] ?? priority ?? '-';
  const link = publicId ? `${TICKET_BASE_URL}/${publicId}` : null;
  const heading = HEADINGS[kind] ?? HEADINGS.created;

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
  const [mention, stageName, targets] = await Promise.all([
    getTelegramMention(createdById),
    getStageName(stageId),
    getTargetChatIds(createdById),
  ]);

  if (targets.length === 0) {
    console.warn('Nenhum chat ativo em telegram_chats — cadastre na aba Chats');
    return;
  }

  await broadcastTelegramMessage(targets, buildMessage({ kind, title, priority, publicId, clientName, stageName, mention }));
}

// Compara um ticket aberto com o snapshot em ticket_state e decide: sem
// linha anterior = novo (notifica "criado"); stage_id diferente do salvo =
// mudou de coluna (notifica "atualizado"); igual = nada. Sempre atualiza
// title/priority/client_name/client_id (cosméticos, não entram na decisão).
// Compartilhado por api/poll-tickets.js (automático) e
// api/discover-tickets.js (botão manual "Buscar tickets") — os dois
// caminhos gravam e notificam do mesmo jeito, não só o polling automático.
export async function processTicket(ticket, { stageLabels, clientName, seeding }) {
  const stage = extractStage(ticket, stageLabels);
  const clientId = ticket.mainClientId ?? null;

  const previousRows = await sql`select stage_id, client_name from ticket_state where ticket_id = ${ticket.id}`;
  const previous = previousRows[0];
  const resolvedClientName = clientName ?? previous?.client_name ?? null;

  await sql`
    insert into ticket_state (ticket_id, public_id, stage_id, title, priority, client_name, client_id, created_by_id)
    values (${ticket.id}, ${ticket.publicId ?? null}, ${stage.id}, ${ticket.title ?? null}, ${ticket.priority ?? null}, ${resolvedClientName}, ${clientId}, ${ticket.createdById ?? null})
    on conflict (ticket_id) do update set
      stage_id = excluded.stage_id,
      title = excluded.title,
      priority = excluded.priority,
      client_name = excluded.client_name,
      client_id = excluded.client_id,
      updated_at = now()
  `;

  const kind = !previous ? 'created' : previous.stage_id !== stage.id ? 'updated' : null;
  if (kind && !seeding) {
    await notifyTicketEvent({
      kind,
      title: ticket.title,
      priority: ticket.priority,
      publicId: ticket.publicId,
      clientName: resolvedClientName,
      stageId: stage.id,
      createdById: ticket.createdById,
    });
    return { stage, notified: true, kind };
  }
  return { stage, notified: false, kind };
}

// Um ticket com closedAt setado não é mais "aberto" — a SoftCS não devolve
// mais posição/estágio dele nas varreduras normais, então nada mais o
// atualiza. Se ele tinha linha em ticket_state (era rastreado como aberto),
// isso é uma transição de verdade: notifica "resolvido" e remove a linha
// (ticket fechado não pertence mais ao Kanban de abertos). Um ticket fechado
// que a gente nunca tinha visto aberto é ignorado silenciosamente — não tem
// o que notificar sobre algo que não se sabia que existia. Chamado no lugar
// de processTicket() sempre que `ticket.closedAt` vier preenchido (ver
// api/poll-tickets.js e api/discover-tickets.js).
export async function processClosedTicket(ticket, { stageLabels, seeding }) {
  const previousRows = await sql`select client_name from ticket_state where ticket_id = ${ticket.id}`;
  const previous = previousRows[0];
  if (!previous) return { notified: false, kind: null };

  await sql`delete from ticket_state where ticket_id = ${ticket.id}`;
  if (seeding) return { notified: false, kind: 'closed' };

  const stage = extractStage(ticket, stageLabels);
  await notifyTicketEvent({
    kind: 'closed',
    title: ticket.title,
    priority: ticket.priority,
    publicId: ticket.publicId,
    clientName: previous.client_name,
    stageId: stage.id,
    createdById: ticket.createdById,
  });
  return { notified: true, kind: 'closed' };
}
