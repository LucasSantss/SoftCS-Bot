import sql from './db.js';

// Como identificar uma pessoa (criador, responsável ou CSM do ticket) na
// mensagem do Slack: @menção (<@U…>, só isso notifica a pessoa) quando o
// agente tem slack_user_id (ver lib/slack-users.js — sincronizado por
// e-mail/nome, ou preenchido à mão na aba Agentes); senão o nome
// cadastrado (display_name, importado da tela de Usuários da SoftCS) e por
// último o e-mail. `name` vem cru — quem monta mrkdwn precisa escapar.
// `slackUserId` também alimenta a coluna de pessoa da Lista
// (lib/slack-list.js). null quando o ID nem está em agent_mapping.
export async function getPersonLabel(softcsUserId) {
  if (!softcsUserId) return null;
  const rows = await sql`
    select slack_user_id, display_name, email from agent_mapping where softcs_user_id = ${softcsUserId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    slackUserId: row.slack_user_id ?? null,
    mention: row.slack_user_id ? `<@${row.slack_user_id}>` : null,
    name: row.display_name || row.email || null,
  };
}
