import sql from '../lib/db.js';
import { requireMaster, MASTER_EMAIL, ALLOWED_DOMAIN } from '../lib/auth.js';

// CRUD da allowlist de acesso ao painel — só o master pode ver/editar.
export default async function handler(req, res) {
  const user = await requireMaster(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select email, display_name, added_by, created_at from allowed_users order by created_at asc
    `;
    res.status(200).json(rows.map((r) => ({ ...r, master: r.email === MASTER_EMAIL })));
    return;
  }

  if (req.method === 'POST') {
    const { email, display_name } = req.body ?? {};
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!normalized.endsWith(`@${ALLOWED_DOMAIN}`)) {
      res.status(400).json({ error: `e-mail precisa ser @${ALLOWED_DOMAIN}` });
      return;
    }
    await sql`
      insert into allowed_users (email, display_name, added_by)
      values (${normalized}, ${display_name || null}, ${user.email})
      on conflict (email) do update set display_name = coalesce(excluded.display_name, allowed_users.display_name)
    `;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (email === MASTER_EMAIL) {
      res.status(400).json({ error: 'não dá pra remover o master' });
      return;
    }
    await sql`delete from allowed_users where email = ${email}`;
    await sql`delete from sessions where email = ${email}`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
