import sql from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`
      select chat_id, label, active, created_at
      from telegram_chats
      order by created_at desc
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { chat_id, label } = req.body ?? {};
    if (!chat_id) {
      res.status(400).json({ error: 'chat_id é obrigatório' });
      return;
    }

    await sql`
      insert into telegram_chats (chat_id, label, active)
      values (${String(chat_id)}, ${label || null}, true)
      on conflict (chat_id) do update set label = excluded.label, active = true
    `;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'PATCH') {
    const { chat_id, active } = req.body ?? {};
    if (!chat_id || typeof active !== 'boolean') {
      res.status(400).json({ error: 'chat_id e active são obrigatórios' });
      return;
    }
    await sql`update telegram_chats set active = ${active} where chat_id = ${String(chat_id)}`;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const chatId = req.query.chat_id;
    if (!chatId) {
      res.status(400).json({ error: 'chat_id é obrigatório' });
      return;
    }
    await sql`delete from telegram_chats where chat_id = ${chatId}`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
