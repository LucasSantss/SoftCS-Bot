import sql from './db.js';
import { slackApi } from './slack.js';
import { getSetting, setSettings } from './settings.js';
import { isWebhookTarget } from './slack-webhook.js';

// "Rastreador de tickets": uma Slack List (docs.slack.dev/reference/methods/
// slackLists.create) com uma linha por ticket, no estilo do "Rastreador de
// feedback" do modelo de canal do Slack. O bot cria a Lista uma vez (botão
// na aba Chats do painel → createTrackerList), guarda o ID dela e os IDs das
// colunas em `settings`, e daí em diante:
// - ticket novo ganha linha, em silêncio (sem mensagem no canal);
// - mudança de coluna atualiza a linha (e manda a mensagem — ver
//   lib/ticket-notify.js);
// - ticket resolvido fica na Lista com Status = Resolvido.
// Lists só existem em workspace com plano pago. Sem Lista criada, tudo
// aqui vira no-op e as mensagens nos canais continuam funcionando.

const LIST_SETTING_KEY = 'slack_tracker_list';
const LIST_NAME = 'Rastreador de tickets SoftCS';
const TIMEZONE = 'America/Sao_Paulo';

const STATUS_CHOICES = [
  { value: 'aberto', label: 'Aberto', color: 'yellow' },
  { value: 'aguardando', label: 'Aguardando resposta', color: 'red' },
  { value: 'resolvido', label: 'Resolvido', color: 'green' },
];

const PRIORITY_CHOICES = [
  { value: 'P0', label: 'P0 (crítico)', color: 'red' },
  { value: 'P1', label: 'P1', color: 'yellow' },
  { value: 'P2', label: 'P2', color: 'green' },
  { value: 'P3', label: 'P3', color: 'green' },
];

const SCHEMA = [
  { key: 'ticket', name: 'Ticket', type: 'text', is_primary_column: true },
  { key: 'coluna', name: 'Coluna', type: 'text' },
  { key: 'status', name: 'Status', type: 'select', options: { format: 'single_select', choices: STATUS_CHOICES } },
  { key: 'prioridade', name: 'Prioridade', type: 'select', options: { format: 'single_select', choices: PRIORITY_CHOICES } },
  { key: 'cliente', name: 'Cliente', type: 'text' },
  { key: 'jornada', name: 'Jornada', type: 'text' },
  { key: 'criado_por', name: 'Criado por', type: 'user', options: { format: 'single_entity' } },
  { key: 'responsavel', name: 'Responsável', type: 'user', options: { format: 'single_entity' } },
  { key: 'csm', name: 'CSM', type: 'user', options: { format: 'single_entity' } },
  { key: 'link', name: 'Link', type: 'link' },
  { key: 'atualizado_em', name: 'Atualizado em', type: 'date' },
];

// Cache curto (a função fica "quente" entre chamadas na Vercel): evita ler
// `settings` a cada ticket, mas enxerga em até 1 min uma Lista recém-criada
// por outra instância.
const CONFIG_TTL_MS = 60 * 1000;
let cachedConfig;
let cachedAt = 0;

export async function getTrackerList() {
  if (cachedConfig !== undefined && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  const raw = await getSetting(LIST_SETTING_KEY);
  cachedConfig = raw ? JSON.parse(raw) : null;
  cachedAt = Date.now();
  return cachedConfig;
}

// Cria a Lista com as colunas acima e libera acesso de edição pros canais
// ativos cadastrados (os membros do canal passam a ver a Lista). Recusa
// criar uma segunda se já existir — pra recriar, apague a chave
// `slack_tracker_list` da tabela settings.
export async function createTrackerList() {
  const existing = await getTrackerList();
  if (existing) return { created: false, listId: existing.listId };

  const data = await slackApi('slackLists.create', { name: LIST_NAME, schema: SCHEMA });
  const schema = data.list_metadata?.schema ?? [];
  const columns = {};
  const options = {};
  for (const col of schema) {
    if (!col.key || !col.id) continue;
    columns[col.key] = col.id;
    const choices = col.options?.choices;
    if (Array.isArray(choices)) {
      options[col.key] = Object.fromEntries(choices.map((c) => [c.value, c.id ?? c.value]));
    }
  }
  const missing = SCHEMA.map((c) => c.key).filter((key) => !columns[key]);
  if (missing.length) throw new Error(`Lista criada (${data.list_id}), mas o Slack não devolveu o ID das colunas: ${missing.join(', ')}`);

  cachedConfig = { listId: data.list_id, columns, options };
  cachedAt = Date.now();
  await setSettings({ [LIST_SETTING_KEY]: JSON.stringify(cachedConfig) });

  const channels = await sql`select chat_id from slack_channels where active = true`;
  await grantChannelAccess(channels.map((c) => c.chat_id));
  return { created: true, listId: data.list_id };
}

// Chamado também ao cadastrar um canal novo na aba Chats (api/chats.js).
export async function grantChannelAccess(targets) {
  const list = await getTrackerList();
  // URL de fluxo de trabalho não é canal — não dá pra dar acesso à Lista.
  const channelIds = targets.filter((t) => !isWebhookTarget(t));
  if (!list || channelIds.length === 0) return;
  await slackApi('slackLists.access.set', { list_id: list.listId, access_level: 'write', channel_ids: channelIds });
}

function richText(text) {
  return [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }];
}

function todayInTimezone() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

// A doc do Slack mostra select ora pelo `value` da opção, ora pelo ID dela
// (OptXXX) — `useOptionIds` decide qual mandar (ver withOptionRetry).
function buildFields(list, info, useOptionIds) {
  const select = (key, value) => [useOptionIds ? (list.options?.[key]?.[value] ?? value) : value];
  const fields = [];
  const push = (key, value) => fields.push({ column_id: list.columns[key], ...value });

  push('ticket', { rich_text: richText(info.title || '(sem título)') });
  if (info.stageName) push('coluna', { rich_text: richText(info.stageName) });
  if (info.status) push('status', { select: select('status', info.status) });
  if (PRIORITY_CHOICES.some((c) => c.value === info.priority)) push('prioridade', { select: select('prioridade', info.priority) });
  if (info.clientName) push('cliente', { rich_text: richText(info.clientName) });
  if (info.journeyNames?.length) push('jornada', { rich_text: richText(info.journeyNames.join(', ')) });
  if (info.creatorSlackId) push('criado_por', { user: [info.creatorSlackId] });
  if (info.agentSlackId) push('responsavel', { user: [info.agentSlackId] });
  if (info.csmSlackId) push('csm', { user: [info.csmSlackId] });
  if (info.url) push('link', { link: [{ original_url: info.url, display_as_url: false, display_name: `Ticket #${info.publicId ?? ''}`.trim() }] });
  push('atualizado_em', { date: [todayInTimezone()] });
  return fields;
}

async function withOptionRetry(fn) {
  try {
    return await fn(false);
  } catch (err) {
    if (err.slackError !== 'invalid_option_id') throw err;
    return fn(true);
  }
}

// Reserva a criação da linha de um ticket: com duas sincronizações
// simultâneas, só uma ganha e cria (sem linha duplicada na Lista). Reserva
// sem row_id há mais de 10 min = criação que falhou no meio, pode tentar de
// novo.
async function claimRowCreation(ticketId) {
  const rows = await sql`
    insert into slack_list_rows (ticket_id) values (${ticketId})
    on conflict (ticket_id) do update set claimed_at = now()
    where slack_list_rows.row_id is null and slack_list_rows.claimed_at < now() - interval '10 minutes'
    returning ticket_id
  `;
  return rows.length > 0;
}

// Cria ou atualiza a linha do ticket. `budget` ({ remaining }) limita
// quantas linhas NOVAS uma sincronização cria (rate limit do Slack, ~50 por
// minuto) — o resto entra nas próximas rodadas. Sem `budget`, cria sempre
// (usado na mudança de coluna). `onlyExisting`: só atualiza, nunca cria
// (ticket resolvido que nunca entrou na Lista não precisa entrar). Erro
// aqui nunca derruba a sincronização.
export async function upsertTicketRow(info, { budget, onlyExisting = false } = {}) {
  try {
    const list = await getTrackerList();
    if (!list) return;

    const existing = await sql`select row_id from slack_list_rows where ticket_id = ${info.ticketId}`;
    const rowId = existing[0]?.row_id;

    if (rowId) {
      await withOptionRetry((useOptionIds) =>
        slackApi('slackLists.items.update', {
          list_id: list.listId,
          cells: buildFields(list, info, useOptionIds).map((f) => ({ row_id: rowId, ...f })),
        })
      );
      return;
    }

    if (onlyExisting) return;
    if (budget) {
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;
    }
    if (!(await claimRowCreation(info.ticketId))) return;

    try {
      const data = await withOptionRetry((useOptionIds) =>
        slackApi('slackLists.items.create', { list_id: list.listId, initial_fields: buildFields(list, info, useOptionIds) })
      );
      const newRowId = data.item?.id ?? data.id;
      await sql`update slack_list_rows set row_id = ${newRowId} where ticket_id = ${info.ticketId}`;
    } catch (err) {
      await sql`delete from slack_list_rows where ticket_id = ${info.ticketId} and row_id is null`;
      throw err;
    }
  } catch (err) {
    if (err.rateLimited && budget) budget.remaining = 0;
    console.error(`Falha ao atualizar a Lista do Slack (ticket ${info.ticketId}):`, err.message);
  }
}

// Tickets que já têm linha na Lista — lido uma vez por sincronização
// (lib/ticket-sync.js), em vez de uma consulta por ticket. null = Lista
// ainda não criada (nada a fazer).
export async function getTicketIdsWithRows() {
  if (!(await getTrackerList())) return null;
  const rows = await sql`select ticket_id from slack_list_rows where row_id is not null`;
  return new Set(rows.map((r) => r.ticket_id));
}
