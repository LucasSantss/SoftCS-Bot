import sql from '../lib/db.js';
import { getValidAccessToken, renewTokenAtCycleEnd } from '../lib/softcs-api.js';
import { requireSession } from '../lib/auth.js';
import { SEED_FLAG_KEY } from '../lib/ticket-notify.js';
import { getSetting, setSettings } from '../lib/settings.js';
import { extractCreator } from '../lib/ticket-scan.js';
import { syncTickets } from '../lib/ticket-sync.js';

// Busca ao vivo ("Buscar todos os tickets abertos" na aba Tickets): a mesma
// sincronização completa do polling automático (syncTickets em
// lib/ticket-sync.js, via POST /tickets/search) — grava em ticket_state e
// notifica igual, então um clique manual também conta como detecção de
// mudança. Uma chamada só cobre a conta inteira, sem lotes.
async function handleLive(req, res) {
  await getValidAccessToken();
  const seeding = (await getSetting(SEED_FLAG_KEY)) !== 'true';

  const { open, stats } = await syncTickets({ seeding });
  if (seeding) await setSettings({ [SEED_FLAG_KEY]: 'true' });

  const creatorsById = new Map();
  const tickets = open.map(({ ticket, stage, clientName }) => {
    const creator = extractCreator(ticket);
    if (creator && !creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);
    return {
      id: ticket.id,
      publicId: ticket.publicId ?? null,
      title: ticket.title ?? '(sem título)',
      priority: ticket.priority ?? null,
      clientName,
      createdAt: ticket.createdAt ?? null,
      createdBy: creator,
      stage,
    };
  });

  // Garante o token renovado no fim de cada finalização, sem pular nenhuma
  // — ver renewTokenAtCycleEnd em lib/softcs-api.js.
  await renewTokenAtCycleEnd();

  res.status(200).json({
    tickets,
    creators: [...creatorsById.values()],
    hasNames: tickets.some((t) => t.createdBy?.name),
    notified: stats.notified,
  });
}

// ?source=stored lê o Kanban salvo em ticket_state (mantido pelo polling em
// api/poll-tickets.js) em vez de buscar na SoftCS ao vivo — é o que o
// painel carrega sozinho ao abrir a página, pra o board ficar disponível na
// hora e só mudar quando o polling realmente detectar algo.
async function handleStored(req, res) {
  const rows = await sql`
    select
      ts.ticket_id, ts.public_id, ts.stage_id, ts.title, ts.priority, ts.client_name,
      ts.created_by_id, ts.updated_at,
      sl.label as stage_label, sl.position as stage_position,
      am.display_name as creator_name, am.email as creator_email
    from ticket_state ts
    left join stage_labels sl on sl.stage_id = ts.stage_id
    left join agent_mapping am on am.softcs_user_id = ts.created_by_id
    order by ts.updated_at desc
  `;

  const creatorsById = new Map();
  const tickets = rows.map((r) => {
    const createdBy = r.created_by_id
      ? { id: r.created_by_id, name: r.creator_name ?? null, email: r.creator_email ?? null }
      : null;
    if (createdBy && !creatorsById.has(createdBy.id)) creatorsById.set(createdBy.id, createdBy);

    return {
      id: r.ticket_id,
      publicId: r.public_id,
      title: r.title ?? '(sem título)',
      priority: r.priority,
      clientName: r.client_name,
      createdAt: null,
      createdBy,
      stage: {
        id: r.stage_id ?? 'sem-estagio',
        name: r.stage_label ?? (r.stage_id ? `Coluna #${r.stage_id.slice(-4)}` : 'Sem estágio'),
        color: null,
        position: typeof r.stage_position === 'number' ? r.stage_position : 999,
      },
    };
  });

  res.status(200).json({
    tickets,
    creators: [...creatorsById.values()],
    hasNames: tickets.some((t) => t.createdBy?.name),
    stored: true,
  });
}

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (req.query.source === 'stored') {
    try {
      await handleStored(req, res);
    } catch (error) {
      console.error('Erro lendo o Kanban salvo:', error);
      res.status(500).json({ error: error.message });
    }
    return;
  }

  try {
    await handleLive(req, res);
  } catch (error) {
    console.error('Erro buscando tickets na SoftCS:', error);
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
