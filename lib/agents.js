import sql from './db.js';

// Busca o @username do Telegram cadastrado manualmente para um usuário SoftCS.
// Retorna null se ainda não houver mapeamento (o ID precisa ser adicionado à mão
// em / (raiz do domínio), já que a API pública não expõe uma lista de agentes/usuários).
export async function getTelegramMention(softcsUserId) {
  if (!softcsUserId) return null;
  const rows = await sql`
    select telegram_username from agent_mapping where softcs_user_id = ${softcsUserId}
  `;
  const username = rows[0]?.telegram_username;
  return username ? `@${username.replace(/^@/, '')}` : null;
}
