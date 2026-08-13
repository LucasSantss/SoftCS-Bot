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

// Chats onde o criador do ticket é membro cadastrado (chat_agents, inclui
// inscrição pessoal via /status) OU onde alguém segue um grupo de jornada
// (aba Jornadas, chat_journey_groups) que contenha alguma das jornadas do
// cliente dono do ticket — os dois são ADITIVOS: um ticket pode notificar o
// chat do criador E o(s) chat(s) inscritos no grupo da jornada do cliente,
// sem duplicar se for o mesmo chat. Só cai no fallback de grupos/canais
// (nunca em chats pessoais — is_personal) se NENHUM dos dois achar alvo
// nenhum; senão qualquer ticket de um criador ou jornada sem mapeamento
// vazava pra todo mundo inscrito, sem filtro nenhum (bug real encontrado ao
// vivo). Cada item devolvido tem { chatId, threadId } — threadId vem de
// telegram_chats.thread_id quando o chat é um Tópico específico dentro de
// um grupo (ver aba Chats).
export async function getTargetChatIds(createdById, journeyNames) {
  const targets = new Map();

  if (createdById) {
    const rows = await sql`
      select c.chat_id, c.thread_id
      from chat_agents a
      join telegram_chats c on c.chat_id = a.chat_id
      where a.softcs_user_id = ${createdById} and c.active = true
    `;
    for (const r of rows) targets.set(r.chat_id, { chatId: r.chat_id, threadId: r.thread_id });
  }

  if (journeyNames?.length) {
    const rows = await sql`
      select distinct c.chat_id, c.thread_id
      from journey_group_items i
      join chat_journey_groups g on g.command = i.command
      join telegram_chats c on c.chat_id = g.chat_id
      where i.journey_name = any(${journeyNames}) and c.active = true
    `;
    for (const r of rows) targets.set(r.chat_id, { chatId: r.chat_id, threadId: r.thread_id });
  }

  if (targets.size > 0) return [...targets.values()];

  const rows = await sql`select chat_id, thread_id from telegram_chats where active = true and is_personal = false`;
  return rows.map((r) => ({ chatId: r.chat_id, threadId: r.thread_id }));
}

const HEADINGS = {
  created: '🎫 <b>Novo ticket</b>',
  updated: '🔄 <b>Ticket atualizado</b>',
  closed: '✅ <b>Ticket resolvido</b>',
};

function buildMessage({ kind, title, priority, publicId, clientName, stageName, mention, journeyNames }) {
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
    journeyNames?.length ? `Jornada: ${escapeHtml(journeyNames.join(', '))}` : null,
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
export async function notifyTicketEvent({ kind, title, priority, publicId, clientName, stageId, createdById, journeyNames }) {
  const [mention, stageName, targets] = await Promise.all([
    getTelegramMention(createdById),
    getStageName(stageId),
    getTargetChatIds(createdById, journeyNames),
  ]);

  if (targets.length === 0) {
    console.warn('Nenhum chat ativo em telegram_chats — cadastre na aba Chats');
    return;
  }

  await broadcastTelegramMessage(
    targets,
    buildMessage({ kind, title, priority, publicId, clientName, stageName, mention, journeyNames })
  );
}

// Compara um ticket aberto com o snapshot em ticket_state e decide: sem
// linha anterior = novo (notifica "criado"); stage_id diferente do salvo =
// mudou de coluna (notifica "atualizado"); igual = nada. Sempre atualiza
// title/priority/client_name/client_id (cosméticos, não entram na decisão).
// Compartilhado por api/poll-tickets.js (automático) e
// api/discover-tickets.js (botão manual "Buscar tickets") — os dois
// caminhos gravam e notificam do mesmo jeito, não só o polling automático.
export async function processTicket(ticket, { stageLabels, clientName, journeyNames, seeding }) {
  const stage = extractStage(ticket, stageLabels);
  const clientId = ticket.mainClientId ?? null;

  const previousRows = await sql`select stage_id, client_name, journey_names from ticket_state where ticket_id = ${ticket.id}`;
  const previous = previousRows[0];
  const resolvedClientName = clientName ?? previous?.client_name ?? null;
  // journeyNames só vem preenchido na fase de descoberta (única que tem os
  // objetos de cliente completos — ver api/poll-tickets.js); a fase known
  // preserva o que já estava salvo em vez de apagar.
  const resolvedJourneyNames = journeyNames ?? previous?.journey_names ?? null;

  await sql`
    insert into ticket_state (ticket_id, public_id, stage_id, title, priority, client_name, client_id, created_by_id, journey_names)
    values (${ticket.id}, ${ticket.publicId ?? null}, ${stage.id}, ${ticket.title ?? null}, ${ticket.priority ?? null}, ${resolvedClientName}, ${clientId}, ${ticket.createdById ?? null}, ${resolvedJourneyNames})
    on conflict (ticket_id) do update set
      stage_id = excluded.stage_id,
      title = excluded.title,
      priority = excluded.priority,
      client_name = excluded.client_name,
      client_id = excluded.client_id,
      journey_names = excluded.journey_names,
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
      journeyNames: resolvedJourneyNames,
    });
    return { stage, notified: true, kind };
  }
  return { stage, notified: false, kind };
}

// Chamado no lugar de processTicket() sempre que o stage_id atual do ticket
// for um estágio marcado como encerramento (stage_labels.is_closed_stage —
// ver aviso em schema.sql sobre por que não usamos ticket.closedAt pra essa
// decisão). Se o ticket tinha linha em ticket_state (era rastreado como
// aberto), isso é uma transição de verdade: notifica "resolvido" e remove a
// linha (ticket fechado não pertence mais ao Kanban de abertos). Um ticket
// que já chega num estágio de encerramento sem nunca ter sido visto aberto
// é ignorado silenciosamente — não tem o que notificar sobre algo que não
// se sabia que existia.
export async function processClosedTicket(ticket, { stageLabels, seeding }) {
  const previousRows = await sql`select client_name, journey_names from ticket_state where ticket_id = ${ticket.id}`;
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
    journeyNames: previous.journey_names,
  });
  return { notified: true, kind: 'closed' };
}
