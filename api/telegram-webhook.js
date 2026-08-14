import sql from '../lib/db.js';
import { sendTelegramMessageToChat, escapeHtml } from '../lib/telegram.js';
import { keyboardMarkup, inlineLinkMarkup } from '../lib/telegram-keyboards.js';

const TICKETS_BOARD_URL = 'https://admin.softcs.com.br/pt-br/tickets';

// Recebe updates do bot do Telegram (mensagens mandadas pra ele) — configurado
// via setWebhook, ver README. Trata /id (funciona em qualquer chat — grupo,
// canal ou privado) e /start, /status, /stop, /notificacoes e os comandos
// dinâmicos de cada grupo de jornada (só no privado — ver handleGroupToggle);
// nenhum outro comando é tratado ainda. Não exige sessão (é o Telegram que
// chama isso, não um navegador logado) — autenticado pelo header secreto que
// o Telegram reenvia em toda chamada (setWebhook com secret_token), não por
// cookie.
async function findAgentByTelegramUsername(username) {
  const rows = await sql`
    select softcs_user_id, display_name from agent_mapping
    where lower(telegram_username) = lower(${username})
    limit 1
  `;
  return rows[0] ?? null;
}

// /id: funciona em QUALQUER chat (grupo, canal, privado — diferente de todo
// resto, que só faz sentido no privado), pra facilitar descobrir o chat_id
// na hora de cadastrar um chat na aba Chats, sem precisar caçar em
// getUpdates manualmente. Se mandado dentro de um Tópico (grupo em modo
// fórum), o próprio update já traz message_thread_id — devolve ele também,
// e responde no mesmo tópico (ver handler abaixo).
function handleId({ chat, messageThreadId }) {
  const lines = [`ID deste chat: <code>${chat.id}</code>`];
  if (chat.type !== 'private') {
    lines.push(`Tipo: ${escapeHtml(chat.type)}${chat.title ? ` — "${escapeHtml(chat.title)}"` : ''}`);
  }
  if (messageThreadId) {
    lines.push(`ID do tópico (thread_id): <code>${messageThreadId}</code>`);
  }
  return lines.join('\n');
}

// /start: primeira mensagem que o Telegram manda quando alguém abre o chat
// com o bot e toca em "Iniciar" (ou digita /start na mão). Manda DUAS
// mensagens de propósito — a Bot API só aceita UM tipo de reply_markup por
// mensagem, não dá pra combinar botão inline (o link pros tickets) com
// botão de teclado (os comandos) na mesma.
async function handleStart() {
  return [
    {
      text:
        '👋 Esse bot avisa aqui no privado sobre tickets da SoftCS.\n\n' +
        '<b>/status</b> — tickets criados por você\n' +
        '<b>/notificacoes</b> — grupos de jornada disponíveis (tickets de clientes numa ' +
        'jornada específica, de qualquer criador)\n' +
        '<b>/stop</b> — para tudo de uma vez\n\n' +
        'Mandar o mesmo comando de novo desliga — não precisa de /stop pra isso.',
      replyMarkup: inlineLinkMarkup([[{ text: '🎫 Ver tickets', url: TICKETS_BOARD_URL }]]),
    },
    {
      text: 'Pra começar:',
      replyMarkup: keyboardMarkup([['/status'], ['/notificacoes']]),
    },
  ];
}

// /status: a pessoa fala com o bot no privado e, já que o handler só chega
// aqui depois de confirmar (mais abaixo) que o @username do Telegram dela
// bate com o que está cadastrado na aba Agentes, o chat privado vira um
// alvo de notificação — dali em diante, todo ticket criado por ela também
// manda uma cópia pro DM, além de onde já ia antes (grupo etc.), até alguém
// desativar esse chat na aba Chats.
async function handleStatus({ chatId, username, agent }) {
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

// /stop: desliga TUDO de uma vez — /status e qualquer grupo de jornada
// seguido — desativando esse chat privado (mesma flag `active` que a aba
// Chats usa pro toggle manual), sem precisar de administrador. Só afeta o
// próprio chat de quem mandou o comando (chat.id de uma DM é o user id da
// pessoa), nunca o de outra pessoa.
async function handleStop({ chatId }) {
  const rows = await sql`
    update telegram_chats set active = false where chat_id = ${String(chatId)} and active = true
    returning chat_id
  `;
  if (rows.length === 0) {
    return 'Você não tinha notificações pessoais ativadas aqui — nada a fazer.';
  }
  return 'Pronto, não vou mais te mandar notificação de ticket aqui. Pra reativar, mande /status ou o comando de algum grupo de jornada quando quiser.';
}

async function listJourneyGroups() {
  return sql`select command, name from journey_groups order by name`;
}

// /notificacoes: lista os grupos de jornada cadastrados na aba Jornadas
// como botões de teclado — tocar num manda o comando daquele grupo, que
// cai no handleGroupToggle abaixo.
async function handleNotifications() {
  const groups = await listJourneyGroups();
  if (groups.length === 0) {
    return 'Nenhum grupo de jornada cadastrado ainda — peça pra um administrador criar um na aba Jornadas do painel.';
  }
  return {
    text: 'Grupos de jornada disponíveis — toque num pra passar a acompanhar (ou parar, se já acompanhava):',
    replyMarkup: keyboardMarkup(groups.map((g) => [`/${g.command}`])),
  };
}

// Comando dinâmico de um grupo de jornada (ex: /onboarding_ativo, criado na
// aba Jornadas): alterna a inscrição (liga se não tinha, desliga se já
// tinha) — todo ticket cujo cliente esteja em QUALQUER jornada do grupo
// notifica esse chat, independente de quem criou o ticket. `agent` só é
// usado aqui pra personalizar a saudação (nome) — o cadastro em si já foi
// exigido mais abaixo, antes de chegar em qualquer comando pessoal.
async function handleGroupToggle({ chatId, username, command, agent }) {
  const groupRows = await sql`select name from journey_groups where command = ${command}`;
  const group = groupRows[0];
  if (!group) return null; // não é um comando de grupo conhecido — deixa cair pro "não reconheço"

  await sql`
    insert into telegram_chats (chat_id, label, active, is_personal)
    values (${String(chatId)}, ${`@${username} (privado)`}, true, true)
    on conflict (chat_id) do update set active = true, is_personal = true
  `;

  const existing = await sql`
    select 1 from chat_journey_groups where chat_id = ${String(chatId)} and command = ${command}
  `;

  if (existing.length > 0) {
    await sql`delete from chat_journey_groups where chat_id = ${String(chatId)} and command = ${command}`;
    return `Pronto, parou de acompanhar "${escapeHtml(group.name)}". Mande /${command} de novo pra voltar.`;
  }

  const journeyRows = await sql`select journey_name from journey_group_items where command = ${command} order by 1`;
  const journeyNames = journeyRows.map((r) => r.journey_name);

  await sql`insert into chat_journey_groups (chat_id, command) values (${String(chatId)}, ${command})`;
  return (
    `Pronto${agent?.display_name ? `, ${escapeHtml(agent.display_name)}` : ''}! A partir de agora você recebe ` +
    `aqui, no privado, os tickets de clientes em "${escapeHtml(group.name)}" (${journeyNames.map(escapeHtml).join(', ')}) ` +
    `— de qualquer criador, não só os seus. Mande /${command} de novo pra parar.`
  );
}

// Pedido explícito: nenhum comando pessoal (nem os de grupo de jornada)
// funciona pra quem não estiver cadastrado na aba Agentes com esse
// @usuário — a pessoa só recebe esse aviso, nada mais é processado.
// Reverte o que valia pra grupo de jornada (não exigia cadastro de agente
// — ver commit "Grupo de jornada não exige mais cadastro de agente pra se
// inscrever"): agora TODOS os comandos pessoais exigem, sem exceção. Não
// se aplica a /id (funciona em qualquer chat, é um utilitário de setup
// pra admin achar chat_id/thread_id, não é sobre notificação pessoal de
// quem manda).
const NOT_REGISTERED_MESSAGE =
  'Você ainda não pode usar comandos nem receber notificações por aqui — seu @usuário do Telegram não está ' +
  'cadastrado na aba Agentes do painel. Peça pra um administrador te cadastrar lá (e, se ainda não tiver um ' +
  '@usuário público, configure um em Ajustes > Editar perfil no Telegram) e tente de novo.';

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
  // qualquer coisa que não seja mensagem de texto é só ignorada.
  if (!message || typeof message.text !== 'string') {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const { command } = parseCommand(message.text);
  if (!command) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  // /id é o único comando que funciona fora do privado (grupo, canal) —
  // todo o resto abaixo é pessoal, exige DM.
  if (command === 'id') {
    try {
      const reply = handleId({ chat: message.chat, messageThreadId: message.message_thread_id });
      await sendTelegramMessageToChat(message.chat.id, reply, message.message_thread_id);
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Erro processando /id:', error);
      res.status(200).json({ ok: true, error: error.message });
    }
    return;
  }

  if (message.chat?.type !== 'private') {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const chatId = message.chat.id;
  const username = message.from?.username ?? null;

  const agent = username ? await findAgentByTelegramUsername(username) : null;
  if (!agent) {
    try {
      await sendTelegramMessageToChat(chatId, NOT_REGISTERED_MESSAGE, undefined);
      res.status(200).json({ ok: true, blocked: true });
    } catch (error) {
      console.error('Erro respondendo aviso de não cadastrado:', error);
      res.status(200).json({ ok: true, error: error.message });
    }
    return;
  }

  try {
    let reply;
    switch (command) {
      case 'start':
        reply = await handleStart();
        break;
      case 'status':
        reply = await handleStatus({ chatId, username, agent });
        break;
      case 'stop':
        reply = await handleStop({ chatId });
        break;
      case 'notificacoes':
        reply = await handleNotifications();
        break;
      default:
        // Não é um comando fixo — só vale a pena checar se é um comando de
        // grupo de jornada (consulta o banco); qualquer outra coisa é
        // ignorada em silêncio, sem gastar consulta à toa.
        reply = await handleGroupToggle({ chatId, username, command, agent });
    }

    if (reply == null) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const messages = Array.isArray(reply) ? reply : [reply];
    for (const item of messages) {
      const { text, replyMarkup } = typeof item === 'string' ? { text: item, replyMarkup: undefined } : item;
      await sendTelegramMessageToChat(chatId, text, undefined, replyMarkup);
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro processando comando do Telegram:', error);
    res.status(200).json({ ok: true, error: error.message });
  }
}
