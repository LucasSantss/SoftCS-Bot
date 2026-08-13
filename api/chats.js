import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select
        c.chat_id, c.label, c.active, c.thread_id, c.is_personal, c.created_at,
        coalesce(
          json_agg(a.softcs_user_id) filter (where a.softcs_user_id is not null),
          '[]'
        ) as member_ids,
        -- só populado quando is_personal (uma inscrição via /status sempre tem
        -- exatamente um membro, o próprio dono do chat) — nome pra exibir na UI
        -- em vez do chat_id cru, ver aba Chats.
        max(am.display_name) filter (where c.is_personal) as agent_display_name
      from telegram_chats c
      left join chat_agents a on a.chat_id = c.chat_id
      left join agent_mapping am on am.softcs_user_id = a.softcs_user_id
      group by c.chat_id, c.label, c.active, c.thread_id, c.is_personal, c.created_at
      order by c.created_at desc
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { chat_id, label, member_ids, thread_id } = req.body ?? {};
    if (!chat_id) {
      res.status(400).json({ error: 'chat_id é obrigatório' });
      return;
    }

    await sql`
      insert into telegram_chats (chat_id, label, active, thread_id)
      values (${String(chat_id)}, ${label || null}, true, ${thread_id ? String(thread_id) : null})
      on conflict (chat_id) do update set label = excluded.label, active = true, thread_id = excluded.thread_id
    `;

    if (Array.isArray(member_ids)) {
      await sql`delete from chat_agents where chat_id = ${String(chat_id)}`;
      for (const softcsUserId of member_ids) {
        await sql`
          insert into chat_agents (chat_id, softcs_user_id)
          values (${String(chat_id)}, ${softcsUserId})
          on conflict do nothing
        `;
      }
    }

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
