const TELEGRAM_API = 'https://api.telegram.org';

// Escapa texto para o modo HTML do Telegram (evita quebrar a mensagem com
// títulos de ticket que contenham <, > ou &).
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendTelegramMessageToChat(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  }

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
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

// Manda a mesma mensagem para todos os chats ativos. Um chat com erro (ex: bot
// removido do grupo) não deve derrubar o envio pros demais.
export async function broadcastTelegramMessage(chatIds, text) {
  const results = await Promise.allSettled(
    chatIds.map((chatId) => sendTelegramMessageToChat(chatId, text))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Falha ao enviar para o chat ${chatIds[i]}:`, result.reason);
    }
  });

  return results;
}
