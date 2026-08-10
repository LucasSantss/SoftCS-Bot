import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';

// Nome e posição das colunas do Kanban, cadastrados manualmente (a API
// pública da SoftCS não devolve nem nome nem posição do estágio, só o
// stageId).
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`select stage_id, label, position from stage_labels`;
    res.status(200).json(Object.fromEntries(rows.map((r) => [r.stage_id, { label: r.label, position: r.position }])));
    return;
  }

  if (req.method === 'POST') {
    const { stage_id, label, position } = req.body ?? {};
    if (!stage_id || !label) {
      res.status(400).json({ error: 'stage_id e label são obrigatórios' });
      return;
    }
    const positionValue = position === undefined || position === null || position === '' ? null : Number(position);
    await sql`
      insert into stage_labels (stage_id, label, position) values (${stage_id}, ${label}, ${positionValue})
      on conflict (stage_id) do update set
        label = excluded.label,
        position = coalesce(excluded.position, stage_labels.position),
        updated_at = now()
    `;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
