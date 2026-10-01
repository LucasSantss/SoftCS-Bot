import sql from './db.js';

// Como identificar o criador do ticket na mensagem: @username quando houver
// (só isso notifica a pessoa no Telegram); senão o nome cadastrado na aba
// Agentes (display_name, importado da tela de Usuários da SoftCS — a busca
// de tickets só devolve o createdById), e por último o e-mail. `name` vem
// cru — quem monta HTML precisa escapar. null quando o ID nem está em
// agent_mapping.
export async function getCreatorLabel(softcsUserId) {
  if (!softcsUserId) return null;
  const rows = await sql`
    select telegram_username, display_name, email from agent_mapping where softcs_user_id = ${softcsUserId}
  `;
  const row = rows[0];
  if (!row) return null;
  const username = row.telegram_username?.replace(/^@/, '');
  return {
    mention: username ? `@${username}` : null,
    name: row.display_name || row.email || null,
  };
}
