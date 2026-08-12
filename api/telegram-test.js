import { sendTelegramMessageToChat } from '../lib/telegram.js';
import { requireSession } from '../lib/auth.js';

// Manda uma mensagem de teste pra um chat_id, acionado pelo botão "Testar"
// na aba Chats — confirma que o chat_id está certo e que o bot ainda
// consegue postar ali (não foi removido do grupo, etc.).
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { chat_id, thread_id } = req.body ?? {};
  if (!chat_id) {
    res.status(400).json({ error: 'chat_id é obrigatório' });
    return;
  }

  try {
    await sendTelegramMessageToChat(chat_id, '✅ Mensagem de teste do SoftCS Bot.', thread_id || undefined);
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}
