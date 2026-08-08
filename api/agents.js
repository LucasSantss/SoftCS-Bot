import sql from '../lib/db.js';
import { checkAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  const { authorized } = await checkAdmin(req);
  if (!authorized) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const rows = await sql`
      select softcs_user_id, telegram_username, display_name, updated_at
      from agent_mapping
      order by display_name nulls last, softcs_user_id
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { softcs_user_id, telegram_username, display_name } = req.body ?? {};
    if (!softcs_user_id || !telegram_username) {
      res.status(400).json({ error: 'softcs_user_id e telegram_username são obrigatórios' });
      return;
    }

    await sql`
      insert into agent_mapping (softcs_user_id, telegram_username, display_name)
      values (${softcs_user_id}, ${telegram_username.replace(/^@/, '')}, ${display_name || null})
      on conflict (softcs_user_id) do update set
        telegram_username = excluded.telegram_username,
        display_name = excluded.display_name,
        updated_at = now()
    `;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const softcsUserId = req.query.softcs_user_id;
    if (!softcsUserId) {
      res.status(400).json({ error: 'softcs_user_id é obrigatório' });
      return;
    }
    await sql`delete from agent_mapping where softcs_user_id = ${softcsUserId}`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
