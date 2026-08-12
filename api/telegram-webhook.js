import sql from '../lib/db.js';
import { sendTelegramMessageToChat, escapeHtml } from '../lib/telegram.js';

// Recebe updates do bot do Telegram (mensagens mandadas pra ele) — configurado
// via setWebhook, ver README. Só existe por causa do comando /status (DM
// pessoal, ver handleStatus abaixo); nenhum outro comando é tratado ainda.
// Não exige sessão (é o Telegram que chama isso, não um navegador logado) —
// autenticado pelo header secreto que o Telegram reenvia em toda chamada
// (setWebhook com secret_token), não por cookie.
async function findAgentByTelegramUsername(username) {
  const rows = await sql`
    select softcs_user_id, display_name from agent_mapping
    where lower(telegram_username) = lower(${username})
    limit 1
  `;
  return rows[0] ?? null;
}

// /status: a pessoa fala com o bot no privado e, se o @username do Telegram
// dela (verificado pelo próprio Telegram no update, não digitado por ela)
// bater com o que está cadastrado na aba Agentes, o chat privado vira um
// alvo de notificação — dali em diante, todo ticket criado por ela também
// manda uma cópia pro DM, além de onde já ia antes (grupo etc.), até alguém
// desativar esse chat na aba Chats. De propósito NÃO aceita a pessoa digitar
// um @ pra se cadastrar como outra pessoa — isso furaria a restrição de só
// agentes já mapeados poderem se inscrever.
async function handleStatus({ chatId, username, displayName }) {
  if (!username) {
    return (
      'Seu Telegram não tem um @usuário público configurado — sem isso não dá pra saber ' +
      'quem você é. Configure um @usuário em Ajustes > Editar perfil no Telegram e mande ' +
      '/status de novo.'
    );
  }

  const agent = await findAgentByTelegramUsername(username);
  if (!agent) {
    return (
      `Não encontrei @${escapeHtml(username)} cadastrado na aba Agentes do painel. Peça pra um ` +
      'administrador te mapear lá (com esse mesmo @usuário) e mande /status de novo.'
    );
  }

  await sql`
    insert into telegram_chats (chat_id, label, active) values (${String(chatId)}, ${`@${username} (privado)`}, true)
    on conflict (chat_id) do update set active = true
  `;
  await sql`
    insert into chat_agents (chat_id, softcs_user_id) values (${String(chatId)}, ${agent.softcs_user_id})
    on conflict do nothing
  `;

  return (
    `Pronto${agent.display_name ? `, ${escapeHtml(agent.display_name)}` : ''}! A partir de agora você ` +
    'recebe aqui, no privado, os tickets criados por você sempre que forem criados ou ' +
    'mudarem de estágio — além de onde essa notificação já ia antes. Pra parar de receber, ' +
    'peça pra um administrador desativar esse chat na aba Chats do painel.'
  );
}

function parseCommand(text) {
  const match = /^\/(\w+)(?:@\w+)?/.exec((text ?? '').trim());
  return match ? match[1].toLowerCase() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const update = req.body ?? {};
  const message = update.message;

  // Sempre responde 200 pro Telegram não ficar reentregando o mesmo update —
  // qualquer coisa que não seja mensagem privada de texto é só ignorada.
  if (!message || message.chat?.type !== 'private' || typeof message.text !== 'string') {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const command = parseCommand(message.text);
  if (command !== 'status') {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  try {
    const reply = await handleStatus({
      chatId: message.chat.id,
      username: message.from?.username ?? null,
      displayName: message.from?.first_name ?? null,
    });
    await sendTelegramMessageToChat(message.chat.id, reply);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando comando do Telegram:', error);
    res.status(200).json({ ok: true, error: error.message });
  }
}
