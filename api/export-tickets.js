import crypto from 'node:crypto';
import sql from '../lib/db.js';
import { getValidAccessToken, renewTokenAtCycleEnd, searchAllTickets } from '../lib/softcs-api.js';
import { getStageLabels } from '../lib/ticket-sync.js';
import { extractStage } from '../lib/ticket-scan.js';
import { resolveClientNames } from '../lib/client-names.js';

// Descrição vem da API como { html } (1,5 MB somando a conta inteira) — vai
// como texto puro e cortada, que é só o que a busca textual de quem consome
// precisa.
const DESCRIPTION_MAX_CHARS = 1000;

function isAuthorized(req) {
  const key = process.env.EXPORT_API_KEY;
  if (!key) return false;
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(req.headers.authorization ?? '');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// Alguns tickets antigos não têm mainClientId — usa o primeiro de clientIds
// quando houver (confirmado ao vivo: dos 33 sem principal, só 1 tinha).
const clientIdOf = (t) => t.mainClientId ?? t.clientIds?.[0] ?? null;

function descriptionText(description) {
  const html = typeof description === 'string' ? description : description?.html;
  if (!html) return '';
  const text = html
    .replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return text.length > DESCRIPTION_MAX_CHARS ? `${text.slice(0, DESCRIPTION_MAX_CHARS)}…` : text;
}

// Exportação read-only de TODOS os tickets da conta (abertos e encerrados),
// já com os nomes que a API pública não traz — coluna (stage_labels),
// agente/criador (agent_mapping, aba Agentes) e cliente (client_names).
// Feita pra outra plataforma consumir servidor-a-servidor (ex: Metricas-CS),
// sem ela precisar da própria conexão OAuth com a SoftCS: o refresh_token
// rotaciona a cada renovação, então dois sistemas renovando a mesma conexão
// invalidariam um ao outro.
//
// Autentica com `Authorization: Bearer <EXPORT_API_KEY>` (env var). Não
// grava ticket_state nem notifica nada — só lê. Sem cache de propósito: a
// resposta depende do header de autorização e não pode ir pra CDN.
export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'não autorizado' });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    await getValidAccessToken();

    const [stageLabels, tickets, agents] = await Promise.all([
      getStageLabels(),
      searchAllTickets({}),
      sql`select softcs_user_id, display_name, email from agent_mapping`,
    ]);
    const agentNameById = new Map(agents.map((a) => [a.softcs_user_id, a.display_name || a.email || null]));
    const person = (id) => (id ? { id, name: agentNameById.get(id) ?? null } : null);

    tickets.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const { nameById, missing } = await resolveClientNames(tickets.map(clientIdOf));

    const data = tickets.map((t) => {
      const stage = extractStage(t, stageLabels);
      const clientId = clientIdOf(t);
      return {
        id: t.id,
        publicId: t.publicId ?? null,
        title: t.title ?? '',
        description: descriptionText(t.description),
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

    await renewTokenAtCycleEnd();

    res.status(200).json({
      generatedAt: new Date().toISOString(),
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
