import sql from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`
      select softcs_user_id, telegram_username, display_name, email, updated_at
      from agent_mapping
      order by display_name nulls last, softcs_user_id
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { softcs_user_id, telegram_username, display_name, email } = req.body ?? {};
    if (!softcs_user_id) {
      res.status(400).json({ error: 'softcs_user_id é obrigatório' });
      return;
    }

    const cleanUsername = telegram_username ? telegram_username.replace(/^@/, '') : null;

    // COALESCE: preenche o que veio, sem apagar o que já estava (ex: preencher
    // só o @ depois não deve zerar o nome/e-mail importados antes, e vice-versa).
    await sql`
      insert into agent_mapping (softcs_user_id, telegram_username, display_name, email)
      values (${softcs_user_id}, ${cleanUsername}, ${display_name || null}, ${email || null})
      on conflict (softcs_user_id) do update set
        telegram_username = coalesce(excluded.telegram_username, agent_mapping.telegram_username),
        display_name = coalesce(excluded.display_name, agent_mapping.display_name),
        email = coalesce(excluded.email, agent_mapping.email),
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
