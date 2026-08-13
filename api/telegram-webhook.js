import sql from '../lib/db.js';
import { sendTelegramMessageToChat, escapeHtml } from '../lib/telegram.js';

// Recebe updates do bot do Telegram (mensagens mandadas pra ele) — configurado
// via setWebhook, ver README. Só existe por causa dos comandos /status,
// /stop, /jornada e /jornadas (DM pessoal, ver handle* abaixo); nenhum
// outro comando é tratado ainda. Não exige sessão (é o Telegram que chama
// isso, não um navegador logado) — autenticado pelo header secreto que o
// Telegram reenvia em toda chamada (setWebhook com secret_token), não por
// cookie.
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
    insert into telegram_chats (chat_id, label, active, is_personal)
    values (${String(chatId)}, ${`@${username} (privado)`}, true, true)
    on conflict (chat_id) do update set active = true, is_personal = true
  `;
  await sql`
    insert into chat_agents (chat_id, softcs_user_id) values (${String(chatId)}, ${agent.softcs_user_id})
    on conflict do nothing
  `;

  return (
    `Pronto${agent.display_name ? `, ${escapeHtml(agent.display_name)}` : ''}! A partir de agora você ` +
    'recebe aqui, no privado, os tickets criados por você sempre que forem criados ou ' +
    'mudarem de estágio até você mandar /stop.'
  );
}

// /stop: desfaz o /status — desativa esse chat privado (mesma flag `active`
// que a aba Chats usa pro toggle manual), sem precisar de administrador.
// Só afeta o próprio chat de quem mandou o comando (chat.id de uma DM é o
// user id da pessoa), nunca o de outra pessoa.
async function handleStop({ chatId }) {
  const rows = await sql`
    update telegram_chats set active = false where chat_id = ${String(chatId)} and active = true
    returning chat_id
  `;
  if (rows.length === 0) {
    return 'Você não tinha notificações pessoais ativadas aqui — nada a fazer.';
  }
  return 'Pronto, não vou mais te mandar notificação de ticket aqui. Pra reativar, mande /status de novo quando quiser.';
}

// Nomes de jornada distintos vistos entre os tickets abertos rastreados —
// alimentado por api/poll-tickets.js/api/discover-tickets.js na fase de
// descoberta (única com acesso aos dados de cliente, que já vêm com o nome
// pronto — ver extractJourneyNames em lib/ticket-scan.js). É contra essa
// lista que /jornada valida o nome digitado.
async function listKnownJourneyNames() {
  const rows = await sql`
    select distinct unnest(journey_names) as name from ticket_state where journey_names is not null order by 1
  `;
  return rows.map((r) => r.name);
}

// /jornadas (plural, sem argumento): lista as jornadas que têm ticket
// aberto rastreado agora, pra pessoa saber exatamente o que digitar no
// /jornada (nome tem que bater, sem diferenciar maiúsculas/minúsculas).
async function handleJourneysList() {
  const names = await listKnownJourneyNames();
  if (names.length === 0) {
    return 'Nenhuma jornada com ticket aberto rastreado ainda — tente de novo depois de uma varredura.';
  }
  return `Jornadas com ticket aberto agora:\n${names.map((n) => `• ${escapeHtml(n)}`).join('\n')}\n\nMande /jornada seguido do nome pra acompanhar (ex: /jornada ${names[0]}).`;
}

// /jornada <nome>: alterna a inscrição (liga se não tinha, desliga se já
// tinha) num grupo de notificação por jornada — todo ticket cujo cliente
// esteja nessa jornada notifica esse chat, além do roteamento por criador
// que já existia (ver getTargetChatIds em lib/ticket-notify.js). Mesma
// restrição de segurança do /status: só quem já está mapeado na aba
// Agentes (via @usuário verificado pelo próprio Telegram) pode se
// inscrever — sem isso, qualquer um poderia se cadastrar em qualquer grupo
// de notificação.
async function handleJourneySubscribe({ chatId, username, journeyNameRaw }) {
  if (!username) {
    return (
      'Seu Telegram não tem um @usuário público configurado — sem isso não dá pra saber ' +
      'quem você é. Configure um @usuário em Ajustes > Editar perfil no Telegram e tente de novo.'
    );
  }

  const agent = await findAgentByTelegramUsername(username);
  if (!agent) {
    return (
      `Não encontrei @${escapeHtml(username)} cadastrado na aba Agentes do painel. Peça pra um ` +
      'administrador te mapear lá (com esse mesmo @usuário) e tente de novo.'
    );
  }

  if (!journeyNameRaw) {
    return 'Uso: /jornada NOME (ex: /jornada Implantação Oficial). Mande /jornadas pra ver os nomes disponíveis.';
  }

  const knownNames = await listKnownJourneyNames();
  const canonicalName = knownNames.find((n) => n.toLowerCase() === journeyNameRaw.toLowerCase());
  if (!canonicalName) {
    return (
      `Não reconheço a jornada "${escapeHtml(journeyNameRaw)}" entre as que têm ticket aberto agora. ` +
      'Mande /jornadas pra ver a lista certinha.'
    );
  }

  await sql`
    insert into telegram_chats (chat_id, label, active, is_personal)
    values (${String(chatId)}, ${`@${username} (privado)`}, true, true)
    on conflict (chat_id) do update set active = true, is_personal = true
  `;

  const existing = await sql`
    select 1 from chat_journeys where chat_id = ${String(chatId)} and journey_name = ${canonicalName}
  `;

  if (existing.length > 0) {
    await sql`delete from chat_journeys where chat_id = ${String(chatId)} and journey_name = ${canonicalName}`;
    return `Pronto, parou de acompanhar a jornada "${escapeHtml(canonicalName)}". Mande /jornada de novo com o mesmo nome pra voltar a acompanhar.`;
  }

  await sql`insert into chat_journeys (chat_id, journey_name) values (${String(chatId)}, ${canonicalName})`;
  return (
    `Pronto${agent.display_name ? `, ${escapeHtml(agent.display_name)}` : ''}! A partir de agora você recebe ` +
    `aqui, no privado, os tickets de clientes na jornada "${escapeHtml(canonicalName)}" — de qualquer criador, ` +
    'não só os seus. Mande /jornada com o mesmo nome de novo pra parar.'
  );
}

function parseCommand(text) {
  const match = /^\/(\w+)(?:@\w+)?\s*(.*)$/.exec((text ?? '').trim());
  if (!match) return { command: null, args: '' };
  return { command: match[1].toLowerCase(), args: match[2].trim() };
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

  const { command, args } = parseCommand(message.text);
  if (!['status', 'stop', 'jornada', 'jornadas'].includes(command)) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const chatId = message.chat.id;
  const username = message.from?.username ?? null;

  try {
    let reply;
    switch (command) {
      case 'status':
        reply = await handleStatus({ chatId, username, displayName: message.from?.first_name ?? null });
        break;
      case 'stop':
        reply = await handleStop({ chatId });
        break;
      case 'jornadas':
        reply = await handleJourneysList();
        break;
      case 'jornada':
        reply = await handleJourneySubscribe({ chatId, username, journeyNameRaw: args });
        break;
    }
    await sendTelegramMessageToChat(chatId, reply);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando comando do Telegram:', error);
    res.status(200).json({ ok: true, error: error.message });
  }
}
