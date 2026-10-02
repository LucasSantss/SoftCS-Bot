import { sendTelegramMessageToChat } from '../lib/telegram.js';
import { requireSession } from '../lib/auth.js';
import { getOverdueAwaitingResponseTickets, buildAwaitingResponseMessages } from '../lib/awaiting-response.js';

// Manda uma mensagem de teste pra um chat_id, acionado pelo botão "Testar"
// na aba Chats — confirma que o chat_id está certo e que o bot ainda
// consegue postar ali (não foi removido do grupo, etc.). Com
// `kind: 'awaiting_response'` (botão "Testar lembrete", só no chat do
// Lucas Rodrigues — ver admin.js), manda a lista REAL de tickets parados em
// "Aguardando Resposta" agora, igual ao que o lembrete das 9h mandaria —
// não mexe na flag de "já enviado hoje" (settings), então não interfere no
// envio automático.
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { chat_id, thread_id, kind } = req.body ?? {};
  if (!chat_id) {
    res.status(400).json({ error: 'chat_id é obrigatório' });
    return;
  }

  try {
    if (kind === 'awaiting_response') {
      const { tickets } = await getOverdueAwaitingResponseTickets();
      const messages = buildAwaitingResponseMessages(tickets);
      for (const text of messages) {
        await sendTelegramMessageToChat(chat_id, text, thread_id || undefined);
      }
    } else {
      await sendTelegramMessageToChat(chat_id, '✅ Mensagem de teste do SoftCS Bot.', thread_id || undefined);
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}
