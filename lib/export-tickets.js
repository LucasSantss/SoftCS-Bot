import crypto from 'node:crypto';
import sql from './db.js';
import { getValidAccessToken, renewTokenAtCycleEnd } from './softcs-api.js';
import { getSetting } from './settings.js';
import { getStageLabels } from './ticket-sync.js';
import { extractStage } from './ticket-scan.js';
import { resolveClientNames } from './client-names.js';
import { SYNCED_AT_KEY, clientIdOf, isSnapshotEmpty, refreshSnapshot } from './ticket-snapshot.js';

function isAuthorized(req) {
  const key = process.env.EXPORT_API_KEY;
  if (!key) return false;
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(req.headers.authorization ?? '');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// Exportação read-only de TODOS os tickets da conta (abertos e encerrados),
// já com os nomes que a API pública não traz — coluna (stage_labels),
// agente/criador (agent_mapping, aba Agentes) e cliente (client_names).
// Feita pra outra plataforma consumir servidor-a-servidor (ex: Metricas-CS),
// sem ela precisar da própria conexão OAuth com a SoftCS: o refresh_token
// rotaciona a cada renovação, então dois sistemas renovando a mesma conexão
// invalidariam um ao outro.
//
// Lê de ticket_snapshot (mantida pelo polling a cada rodada — ver
// lib/ticket-snapshot.js), então responde rápido e sem chamar a SoftCS.
// `?refresh=1` faz uma atualização incremental antes de ler (botão
// "Atualizar agora" de quem consome). Se a cópia ainda estiver vazia (antes
// da primeira rodada do polling), faz a carga completa na hora.
//
// Autentica com `Authorization: Bearer <EXPORT_API_KEY>` (env var). Não
// grava ticket_state nem notifica nada. Sem cache HTTP de propósito: a
// resposta depende do header de autorização e não pode ir pra CDN.
//
// Atende GET /api/export-tickets, que o vercel.json reescreve pra
// /api/discover-tickets?action=export: fica dentro de uma function que já
// existe porque o plano Hobby da Vercel aceita no máximo 12 functions por deploy.
export async function handleExport(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'não autorizado' });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    if (req.query?.refresh === '1' || (await isSnapshotEmpty())) {
      await getValidAccessToken();
      await refreshSnapshot();
      await renewTokenAtCycleEnd();
    }

    const [stageLabels, rows, agents, snapshotAt] = await Promise.all([
      getStageLabels(),
      sql`select data from ticket_snapshot order by softcs_updated_at desc nulls last`,
      sql`select softcs_user_id, display_name, email from agent_mapping`,
      getSetting(SYNCED_AT_KEY),
    ]);
    const tickets = rows.map((r) => r.data);
    const agentNameById = new Map(agents.map((a) => [a.softcs_user_id, a.display_name || a.email || null]));
    const person = (id) => (id ? { id, name: agentNameById.get(id) ?? null } : null);

    const { nameById, missing } = await resolveClientNames(tickets.map(clientIdOf), { fetchMissing: false });

    const data = tickets.map((t) => {
      const stage = extractStage(t, stageLabels);
      const clientId = clientIdOf(t);
      return {
        id: t.id,
        publicId: t.publicId ?? null,
        title: t.title ?? '',
        description: t.description ?? '',
        stage: { id: stage.id, name: stage.name, isClosedStage: stage.isClosedStage },
        status: t.status ?? null,
        resolved: stage.isClosedStage || (t.status != null && t.status !== 'OPEN'),
        priority: t.priority ?? null,
        escalationTier: t.escalationTier ?? null,
        slaHours: t.slaHours ?? null,
        agent: person(t.agentId),
        createdBy: person(t.createdById),
        client: clientId ? { id: clientId, name: nameById.get(clientId) ?? null } : null,
        createdAt: t.createdAt ?? null,
        updatedAt: t.updatedAt ?? null,
        closedAt: t.closedAt ?? null,
      };
    });

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      snapshotAt,
      count: data.length,
      missingClientNames: missing,
      tickets: data,
    });
  } catch (error) {
    console.error('Erro exportando tickets:', error);
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
