import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select softcs_user_id, slack_user_id, slack_user_id_manual, display_name, email, updated_at
      from agent_mapping
      order by display_name nulls last, softcs_user_id
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { softcs_user_id, slack_user_id, display_name, email } = req.body ?? {};
    if (!softcs_user_id) {
      res.status(400).json({ error: 'softcs_user_id é obrigatório' });
      return;
    }

    // ID de membro do Slack (U…/W… — perfil da pessoa > ⋮ > "Copiar ID de
    // membro"). Preenchido à mão = slack_user_id_manual, e a sincronização
    // automática (lib/slack-users.js) não sobrescreve mais.
    const cleanSlackId = slack_user_id ? String(slack_user_id).trim().toUpperCase() : null;
    if (cleanSlackId && !/^[UW][A-Z0-9]{6,}$/.test(cleanSlackId)) {
      res.status(400).json({ error: 'ID do Slack inválido — use o "ID de membro" (começa com U, ex: U0123ABCDEF)' });
      return;
    }

    // COALESCE: preenche o que veio, sem apagar o que já estava (ex: preencher
    // só o ID do Slack depois não deve zerar o nome/e-mail importados antes).
    await sql`
      insert into agent_mapping (softcs_user_id, slack_user_id, slack_user_id_manual, display_name, email)
      values (${softcs_user_id}, ${cleanSlackId}, ${Boolean(cleanSlackId)}, ${display_name || null}, ${email || null})
      on conflict (softcs_user_id) do update set
        slack_user_id = coalesce(excluded.slack_user_id, agent_mapping.slack_user_id),
        slack_user_id_manual = agent_mapping.slack_user_id_manual or excluded.slack_user_id_manual,
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
