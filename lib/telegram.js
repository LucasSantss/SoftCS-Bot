const TELEGRAM_API = 'https://api.telegram.org';

// Escapa texto para o modo HTML do Telegram (evita quebrar a mensagem com
// títulos de ticket que contenham <, > ou &).
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendTelegramMessageToChat(chatId, text, threadId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  }

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API error (chat ${chatId}): ${data.description}`);
  }
  return data;
}

// Manda a mesma mensagem para todos os chats/tópicos ativos. `targets` é uma
// lista de { chatId, threadId } — threadId é opcional (só grupos em modo
// fórum com uma coluna específica configurada, ver aba Chats). Um chat com
// erro (ex: bot removido do grupo) não deve derrubar o envio pros demais.
export async function broadcastTelegramMessage(targets, text) {
  const results = await Promise.allSettled(
    targets.map(({ chatId, threadId }) => sendTelegramMessageToChat(chatId, text, threadId))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Falha ao enviar para o chat ${targets[i].chatId}:`, result.reason);
    }
  });

  return results;
}
