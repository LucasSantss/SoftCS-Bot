import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';

// Nomes das colunas do Kanban, cadastrados manualmente (a API pública da
// SoftCS não devolve o nome do estágio, só o stageId).
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`select stage_id, label from stage_labels`;
    res.status(200).json(Object.fromEntries(rows.map((r) => [r.stage_id, r.label])));
    return;
  }

  if (req.method === 'POST') {
    const { stage_id, label } = req.body ?? {};
    if (!stage_id || !label) {
      res.status(400).json({ error: 'stage_id e label são obrigatórios' });
      return;
    }
    await sql`
      insert into stage_labels (stage_id, label) values (${stage_id}, ${label})
      on conflict (stage_id) do update set label = excluded.label, updated_at = now()
    `;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
