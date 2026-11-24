import sql from './db.js';
import { slackApi } from './slack.js';

// Liga cada agente da SoftCS (agent_mapping) a um usuário do Slack, pra
// mensagem poder @mencionar de verdade (<@U…>). Ordem de tentativa:
// 1. e-mail igual (o mais confiável — precisa do escopo users:read.email);
// 2. nome igual, sem acento/maiúscula (real_name ou display_name do Slack);
// 3. primeiro + último nome iguais (ex: "Lucas Rodrigues" na SoftCS x
//    "Lucas Santos Rodrigues" no Slack).
// Nome só vale se bater com UMA pessoa — homônimo fica sem mapear, pra
// não mencionar a pessoa errada. Quem não bater preenche o ID à mão na aba
// Agentes (slack_user_id_manual = true, e a sincronização não mexe mais).

function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLast(normalized) {
  const parts = normalized.split(' ').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : null;
}

async function listSlackUsers() {
  const users = [];
  let cursor;
  do {
    const page = await slackApi('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
    users.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor || null;
  } while (cursor);
  return users.filter((u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT');
}

function addToIndex(index, key, id) {
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(id);
}

function uniqueMatch(index, key) {
  const ids = key ? index.get(key) : null;
  return ids && ids.size === 1 ? [...ids][0] : null;
}

// Aceita o JSON de usuários do Slack colado no painel — resposta de
// users.list ({members}), da busca de pessoas ({results}) ou só a lista.
// Fica só com o necessário e descarta desativados e bots.
export function parseSlackUsersJson(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const list = Array.isArray(data) ? data : data?.results ?? data?.members ?? data?.users;
  if (!Array.isArray(list)) {
    throw new Error('JSON sem lista de usuários: esperado "results", "members" ou uma lista');
  }
  return list
    .filter((u) => u && /^[UW][A-Z0-9]{6,}$/.test(String(u.id ?? '')) && !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
    .map((u) => ({
      id: u.id,
      name: u.name ?? null,
      real_name: u.real_name ?? u.profile?.real_name ?? null,
      profile: {
        real_name: u.profile?.real_name ?? null,
        display_name: u.profile?.display_name ?? null,
        email: u.profile?.email ?? u.email ?? null,
      },
    }));
}

function displayOf(u) {
  return u.real_name || u.profile?.real_name || u.profile?.display_name || u.name || u.id;
}

// Liga agentes a usuários do Slack (ver ordem no topo do arquivo, mais o
// usuário do e-mail — "lucas.silva" de lucas.silva@x.com — igual ao
// @usuário do Slack). `force`: refaz também quem já tinha sido mapeado
// automaticamente (nunca mexe em quem foi preenchido à mão).
export async function linkSlackUsers(slackUsers, { force = false } = {}) {
  const byEmail = new Map();
  const byLocalPart = new Map();
  const byName = new Map();
  const byFirstLast = new Map();
  for (const u of slackUsers) {
    const email = u.profile?.email?.toLowerCase();
    if (email) {
      byEmail.set(email, u.id);
      addToIndex(byLocalPart, email.split('@')[0], u.id);
    }
    if (u.name) addToIndex(byLocalPart, String(u.name).toLowerCase(), u.id);
    for (const raw of [u.real_name, u.profile?.real_name, u.profile?.display_name]) {
      const name = normalizeName(raw);
      addToIndex(byName, name, u.id);
      addToIndex(byFirstLast, firstLast(name), u.id);
    }
  }
  // O mesmo usuário pode entrar 2x no índice do @usuário (e-mail e name) —
  // Set resolve; homônimo de verdade continua sem bater.

  const agents = force
    ? await sql`select softcs_user_id, display_name, email, slack_user_id from agent_mapping where slack_user_id_manual = false`
    : await sql`select softcs_user_id, display_name, email, slack_user_id from agent_mapping where slack_user_id_manual = false and slack_user_id is null`;

  const matched = [];
  const unmatched = [];
  for (const agent of agents) {
    const name = normalizeName(agent.display_name);
    const email = agent.email?.toLowerCase() ?? null;
    const viaEmail = email ? byEmail.get(email) ?? uniqueMatch(byLocalPart, email.split('@')[0]) : null;
    const slackUserId = viaEmail ?? uniqueMatch(byName, name) ?? uniqueMatch(byFirstLast, firstLast(name));
    if (slackUserId) {
      if (slackUserId !== agent.slack_user_id) {
        await sql`update agent_mapping set slack_user_id = ${slackUserId}, updated_at = now() where softcs_user_id = ${agent.softcs_user_id}`;
      }
      matched.push({ name: agent.display_name ?? agent.email, via: viaEmail ? 'e-mail' : 'nome' });
    } else {
      unmatched.push(agent.display_name ?? agent.email ?? agent.softcs_user_id);
    }
  }

  return { slackUsers: slackUsers.length, matched: matched.length, unmatched };
}

export async function syncSlackUsers({ force = false } = {}) {
  return linkSlackUsers(await listSlackUsers(), { force });
}

// Importa o JSON do Slack: liga os IDs e, com `chatId`, adiciona como
// membros do canal (chat_agents) os agentes que estão no JSON. Só
// adiciona — não tira quem já era membro. Quem está no JSON mas não é
// agente da SoftCS (ex: liderança sem ticket) volta em `notAgents`.
export async function importSlackUsers(input, { chatId = null } = {}) {
  const slackUsers = parseSlackUsersJson(input);
  if (slackUsers.length === 0) throw new Error('Nenhum usuário ativo no JSON.');
  const link = await linkSlackUsers(slackUsers, { force: true });

  const ids = slackUsers.map((u) => u.id);
  const agents = await sql`
    select softcs_user_id, display_name, email, slack_user_id from agent_mapping where slack_user_id = any(${ids})
  `;
  const agentSlackIds = new Set(agents.map((a) => a.slack_user_id));
  const notAgents = slackUsers.filter((u) => !agentSlackIds.has(u.id)).map(displayOf);

  let added = [];
  if (chatId) {
    const exists = await sql`select 1 from slack_channels where chat_id = ${chatId}`;
    if (exists.length === 0) throw new Error('Canal não encontrado — cadastre o canal antes de importar os membros.');
    for (const a of agents) {
      const rows = await sql`
        insert into chat_agents (chat_id, softcs_user_id) values (${chatId}, ${a.softcs_user_id})
        on conflict do nothing returning softcs_user_id
      `;
      if (rows.length) added.push(a.display_name ?? a.email ?? a.softcs_user_id);
    }
  }

  return {
    slackUsers: slackUsers.length,
    agentIds: agents.map((a) => a.softcs_user_id),
    linked: link.matched,
    agentsInJson: agents.length,
    added,
    notAgents,
  };
}
