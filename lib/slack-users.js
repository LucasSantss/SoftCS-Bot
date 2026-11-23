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

// `force`: refaz também quem já tinha sido mapeado automaticamente (nunca
// mexe em quem foi preenchido à mão).
export async function syncSlackUsers({ force = false } = {}) {
  const slackUsers = await listSlackUsers();
  const byEmail = new Map();
  const byName = new Map();
  const byFirstLast = new Map();
  for (const u of slackUsers) {
    const email = u.profile?.email?.toLowerCase();
    if (email) byEmail.set(email, u.id);
    for (const raw of [u.real_name, u.profile?.real_name, u.profile?.display_name]) {
      const name = normalizeName(raw);
      addToIndex(byName, name, u.id);
      addToIndex(byFirstLast, firstLast(name), u.id);
    }
  }

  const agents = force
    ? await sql`select softcs_user_id, display_name, email, slack_user_id from agent_mapping where slack_user_id_manual = false`
    : await sql`select softcs_user_id, display_name, email, slack_user_id from agent_mapping where slack_user_id_manual = false and slack_user_id is null`;

  const matched = [];
  const unmatched = [];
  for (const agent of agents) {
    const name = normalizeName(agent.display_name);
    const viaEmail = agent.email ? byEmail.get(agent.email.toLowerCase()) : null;
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
