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

  // A API manda o nome (e a posição) do estágio junto com cada ticket
  // (denormalizedStage/stage) — confirmado ao vivo, contrariando o que se
  // pensava antes. Na primeira vez que um stage_id aparece sem label salvo,
  // grava esse nome sozinho em stage_labels — sem isso, só a busca manual ao
  // vivo mostra o nome certo; o Kanban salvo (carregado ao abrir o painel) e
  // as notificações do Telegram ficavam com "Coluna #xxxx" ou sem a linha de
  // estágio até alguém clicar manualmente pra nomear. `on conflict do
  // nothing` garante que isso nunca sobrescreve um nome escolhido à mão.
  const rawStage = ticket.denormalizedStage ?? ticket.stage;
  if (rawStage?.name && !stageLabels[stage.id]) {
    const position = typeof rawStage.position === 'number' ? rawStage.position : null;
    await sql`
      insert into stage_labels (stage_id, label, position) values (${stage.id}, ${rawStage.name}, ${position})
      on conflict (stage_id) do nothing
    `;
    stageLabels[stage.id] = { label: rawStage.name, position };
  }

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
