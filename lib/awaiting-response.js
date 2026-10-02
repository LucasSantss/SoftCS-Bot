import sql from './db.js';
import { getStageLabels } from './ticket-sync.js';
import { resolveClientNames } from './client-names.js';
import { clientIdOf } from './ticket-snapshot.js';
import { escapeHtml, sendTelegramMessageToChat } from './telegram.js';

// Mesmo fuso usado pelo polling (BUSINESS_TIMEZONE em api/poll-tickets.js)
// — "dia" pra esse lembrete é sempre em horário de Brasília, não UTC.
const TIMEZONE = 'America/Sao_Paulo';

// Pedido do usuário: "última atualização até o dia vigente maior que 2
// dias". O exemplo dado (ticket atualizado 01/10/2026 23:59 já deveria
// notificar a partir de 03/10/2026) é uma diferença de 2 dias de
// CALENDÁRIO, não 48h corridas (confirmado com o usuário em 2026-10-02) —
// por isso a comparação abaixo usa só a data (meia-noite a meia-noite no
// fuso de Brasília), ignorando o horário exato da última atualização.
const MIN_DAYS_WAITING = 2;

function dateKeyInTimezone(date) {
  // en-CA formata como YYYY-MM-DD, direto parseável como data UTC "neutra".
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(date);
}

function daysBetweenCalendarDates(pastDateLike, now) {
  const pastMidnight = Date.parse(`${dateKeyInTimezone(new Date(pastDateLike))}T00:00:00Z`);
  const nowMidnight = Date.parse(`${dateKeyInTimezone(now)}T00:00:00Z`);
  return Math.round((nowMidnight - pastMidnight) / 86400000);
}

// Tickets parados na(s) coluna(s) marcada(s) como "Aguardando Resposta"
// (stage_labels.is_awaiting_response_stage) há MIN_DAYS_WAITING dias de
// calendário ou mais, contando da última atualização REAL do ticket na
// SoftCS (ticket_snapshot.softcs_updated_at — não da nossa última
// sincronização, que rodaria a cada poll mesmo sem nada mudar de verdade).
// Lê só de ticket_snapshot, sem chamar a SoftCS.
export async function getOverdueAwaitingResponseTickets(now = new Date()) {
  const stageLabels = await getStageLabels();
  const stageIds = Object.entries(stageLabels)
    .filter(([, s]) => s.is_awaiting_response_stage === true)
    .map(([id]) => id);

  if (stageIds.length === 0) {
    return { configured: false, tickets: [] };
  }

  const rows = await sql`
    select ticket_id, data, softcs_updated_at
    from ticket_snapshot
    where (data ->> 'stageId') = any(${stageIds}) and softcs_updated_at is not null
  `;

  const overdue = rows
    .map((r) => ({ ...r, daysWaiting: daysBetweenCalendarDates(r.softcs_updated_at, now) }))
    .filter((r) => r.daysWaiting >= MIN_DAYS_WAITING);

  const { nameById } = await resolveClientNames(overdue.map((r) => clientIdOf(r.data)), { fetchMissing: false });

  const tickets = overdue
    .map((r) => ({
      id: r.ticket_id,
      publicId: r.data.publicId ?? r.ticket_id,
      title: r.data.title ?? '(sem título)',
      clientName: nameById.get(clientIdOf(r.data)) ?? null,
      daysWaiting: r.daysWaiting,
      lastUpdateAt: r.softcs_updated_at,
    }))
    .sort((a, b) => b.daysWaiting - a.daysWaiting);

  return { configured: true, tickets };
}

const TICKET_BASE_URL = 'https://admin.softcs.com.br/pt-br/tickets';
// Margem abaixo do limite de 4096 caracteres por mensagem da Bot API.
const MAX_MESSAGE_CHARS = 3500;

function formatTicketLine(t) {
  const link = `${TICKET_BASE_URL}/${t.publicId}`;
  const dayLabel = t.daysWaiting === 1 ? '1 dia' : `${t.daysWaiting} dias`;
  return (
    `• Cliente: ${escapeHtml(t.clientName ?? '(desconhecido)')} → ID: <a href="${link}">${escapeHtml(String(t.publicId))}</a>\n` +
    `${escapeHtml(t.title)}\n` +
    `»parado há ${dayLabel} sem atualização`
  );
}

// Quebra em várias mensagens se a lista for grande — a Bot API rejeita
// mensagem com mais de 4096 caracteres.
export function buildAwaitingResponseMessages(tickets) {
  if (tickets.length === 0) {
    return [`✅ Nenhum ticket em "Aguardando Resposta" parado há ${MIN_DAYS_WAITING}+ dias agora.`];
  }

  const header = `⏳ <b>${tickets.length} ticket(s) em "Aguardando Resposta" há ${MIN_DAYS_WAITING}+ dias sem atualização</b>\n\n`;
  const messages = [];
  let current = header;
  for (const t of tickets) {
    const line = `${formatTicketLine(t)}\n\n`;
    if (current.length + line.length > MAX_MESSAGE_CHARS && current !== header) {
      messages.push(current.trim());
      current = '';
    }
    current += line;
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

// Chave em `settings` com a data (YYYY-MM-DD, fuso de Brasília) do último
// envio do lembrete — usada por claimDailyDigestSlot pra mandar só 1x por
// dia mesmo com DOIS crons diferentes (o de 2min e o de 10min, ver
// api/poll-tickets.js) caindo na mesma janela das 9h.
const DIGEST_SENT_DATE_KEY = 'awaiting_response_sent_date';

// `on conflict ... where settings.value is distinct from excluded.value`:
// só grava (e só devolve a linha) se o valor salvo for DIFERENTE do dia de
// hoje — isso faz a reivindicação ser atômica numa instrução só: o primeiro
// tick do dia que chega aqui muda o valor e "ganha" (devolve 1 linha); os
// próximos ticks da mesma janela encontram o valor já igual a hoje e não
// mudam nada (devolvem 0 linhas) — sem precisar de lock separado.
async function claimDailyDigestSlot(dateKey) {
  const rows = await sql`
    insert into settings (key, value) values (${DIGEST_SENT_DATE_KEY}, ${dateKey})
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where settings.value is distinct from excluded.value
    returning key
  `;
  return rows.length > 0;
}

// Manda o(s) lembrete(s) pra quem está inscrito via /resposta (ver
// api/telegram-webhook.js) — lista fixa de assinantes, independente de
// chat_agents/chat_journey_groups.
export async function sendAwaitingResponseDigest(now = new Date()) {
  const { configured, tickets } = await getOverdueAwaitingResponseTickets(now);
  if (!configured) {
    return { sent: false, reason: 'nenhuma coluna marcada como "Aguardando Resposta" (aba Tickets)' };
  }

  const subscribers = await sql`
    select chat_id, thread_id from telegram_chats
    where awaiting_response_subscribed = true and active = true
  `;
  if (subscribers.length === 0) {
    return { sent: false, reason: 'ninguém inscrito via /resposta ainda', ticketCount: tickets.length };
  }

  const messages = buildAwaitingResponseMessages(tickets);
  for (const { chat_id, thread_id } of subscribers) {
    for (const text of messages) {
      await sendTelegramMessageToChat(chat_id, text, thread_id ?? undefined);
    }
  }

  return { sent: true, ticketCount: tickets.length, subscriberCount: subscribers.length };
}

// Chamado em toda rodada do polling normal (api/poll-tickets.js), dentro da
// janela de uma hora (9h, horário de Brasília) — reivindica o dia em
// `settings` (claimDailyDigestSlot, pra não mandar 2x com os dois crons
// existentes) e só então manda de verdade. Reaproveita o MESMO cron que já
// existe pro polling normal (2min/10min) em vez de precisar de uma rotina
// nova no cron-job.org.
export async function maybeSendAwaitingResponseDigest(now = new Date()) {
  const dateKey = dateKeyInTimezone(now);
  const claimed = await claimDailyDigestSlot(dateKey);
  if (!claimed) {
    return { sent: false, reason: 'já reivindicado por outro tick de hoje (ou já enviado hoje)' };
  }
  return sendAwaitingResponseDigest(now);
}
