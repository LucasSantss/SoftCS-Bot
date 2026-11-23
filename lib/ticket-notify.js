import sql from './db.js';
import { getPersonLabel } from './agents.js';
import { escapeMrkdwn, postMessage, updateMessage } from './slack.js';
import { extractStage } from './ticket-scan.js';
import { upsertTicketRow } from './slack-list.js';
import { isWebhookTarget, postWorkflowWebhook } from './slack-webhook.js';

const PRIORITY_LABELS = {
  P0: '🔴 P0 (crítico)',
  P1: '🟠 P1',
  P2: '🟡 P2',
  P3: '🟢 P3',
};

const TICKET_BASE_URL = 'https://admin.softcs.com.br/pt-br/tickets';

// Chave em `settings` que controla o "modo seed": enquanto não estiver
// 'true', qualquer chamador de processTicket() só grava o snapshot, sem
// notificar (ver processTicket abaixo).
export const SEED_FLAG_KEY = 'ticket_poll_seeded';

// Grupo de jornada (journey_groups.command) cujas notificações levam o CSM
// responsável pelo cliente — só a mensagem que vai pros canais que recebem o
// ticket POR ESSE grupo (ou pelo pega-tudo); os demais canais recebem a
// mensagem sem o CSM.
export const CSM_JOURNEY_GROUP = 'ka';

// Canais do Slack (aba Chats do painel) que recebem um ticket. Três
// critérios ADITIVOS, sem duplicar se for o mesmo canal:
// 1. canal onde o criador do ticket é membro cadastrado (chat_agents);
// 2. canal que segue um grupo de jornada (ex: KA, Adoção, Suporte,
//    Implantação) com alguma das jornadas do cliente (chat_journey_groups);
// 3. canal que segue um grupo "pega-tudo" (ex: Todos —
//    journey_groups.is_catch_all).
// Fora o pega-tudo, SEM fallback: se nada bater, ninguém é notificado (pedido
// explícito, depois de um vazamento real onde ticket sem mapeamento
// notificava todo mundo). `showCsm` = o canal recebe o ticket pelo grupo
// CSM_JOURNEY_GROUP, ou pelo pega-tudo com cliente nesse grupo.
export async function getTargetChannels(createdById, journeyNames) {
  const targets = new Map();
  const addTarget = (channelId, showCsm = false) => {
    targets.set(channelId, { channelId, showCsm: (targets.get(channelId)?.showCsm ?? false) || showCsm });
  };

  if (createdById) {
    const rows = await sql`
      select c.chat_id
      from chat_agents a
      join slack_channels c on c.chat_id = a.chat_id
      where a.softcs_user_id = ${createdById} and c.active = true
    `;
    for (const r of rows) addTarget(r.chat_id);
  }

  if (journeyNames?.length) {
    const rows = await sql`
      select c.chat_id, bool_or(i.command = ${CSM_JOURNEY_GROUP}) as via_csm_group
      from journey_group_items i
      join chat_journey_groups g on g.command = i.command
      join slack_channels c on c.chat_id = g.chat_id
      where i.journey_name = any(${journeyNames}) and c.active = true
      group by c.chat_id
    `;
    for (const r of rows) addTarget(r.chat_id, r.via_csm_group);
  }

  const catchAllRows = await sql`
    select distinct c.chat_id
    from chat_journey_groups g
    join journey_groups jg on jg.command = g.command and jg.is_catch_all = true
    join slack_channels c on c.chat_id = g.chat_id
    where c.active = true
  `;
  let isCsmGroupClient = false;
  if (catchAllRows.length && journeyNames?.length) {
    const rows = await sql`
      select 1 from journey_group_items
      where command = ${CSM_JOURNEY_GROUP} and journey_name = any(${journeyNames})
      limit 1
    `;
    isCsmGroupClient = rows.length > 0;
  }
  for (const r of catchAllRows) addTarget(r.chat_id, isCsmGroupClient);

  return [...targets.values()];
}

// Só mudança de coluna notifica (pedido explícito): ticket novo não manda
// mensagem — entra no ticket_state (e na Lista) em silêncio.
const HEADINGS = {
  updated: '🔄 Ticket mudou de coluna',
  // Coluna marcada como "Aguardando Resposta" (stage_labels.is_awaiting_response_stage).
  awaiting: '⚠️ Ticket aguardando resposta',
  closed: '✅ Ticket resolvido',
};

function personText(person, fallback) {
  if (person?.mention) return person.mention;
  if (person?.name) return escapeMrkdwn(person.name);
  return fallback;
}

function peopleLine({ creator, agent, csm, csmLabel, showCsm }) {
  const parts = [`Criado por: ${personText(creator, '(sem mapeamento)')}`];
  if (agent) parts.push(`Responsável: ${personText(agent, '(sem mapeamento)')}`);
  if (showCsm) parts.push(`CSM: ${personText(csmLabel ?? (csm?.name ? { name: csm.name } : null), '(sem CSM no cliente)')}`);
  return parts.join('  ·  ');
}

// Mensagem-mãe do ticket no canal — uma só por ticket por canal, editada a
// cada mudança de coluna (chat.update) pra sempre mostrar o estado atual.
function buildParentMessage(ctx) {
  const { kind, title, priority, publicId, clientName, stageName, journeyNames } = ctx;
  const link = publicId ? `${TICKET_BASE_URL}/${publicId}` : null;
  const heading = HEADINGS[kind] ?? HEADINGS.updated;
  const safeTitle = escapeMrkdwn(title ?? '(sem título)');

  const details = [
    `*Coluna:* ${escapeMrkdwn(stageName ?? '-')}`,
    `*Prioridade:* ${PRIORITY_LABELS[priority] ?? escapeMrkdwn(priority ?? '-')}`,
    clientName ? `*Cliente:* ${escapeMrkdwn(clientName)}` : null,
    journeyNames?.length ? `*Jornada:* ${escapeMrkdwn(journeyNames.join(', '))}` : null,
  ].filter(Boolean);

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${heading}*\n${link ? `<${link}|${safeTitle}>` : `*${safeTitle}*`}` } },
    { type: 'section', text: { type: 'mrkdwn', text: details.join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: peopleLine(ctx) }] },
  ];
  if (link) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Ver ticket' }, url: link, action_id: 'open_ticket' }],
    });
  }

  return { text: `${heading}: ${safeTitle} — ${escapeMrkdwn(stageName ?? '')}`, blocks };
}

// Resposta na thread da mensagem-mãe — o histórico de mudanças. Repete as
// @menções pra quem é mencionado ser notificado de novo.
function buildThreadReply(ctx) {
  const from = ctx.previousStageName ? `*${escapeMrkdwn(ctx.previousStageName)}* → ` : '';
  const verb = ctx.kind === 'closed' ? '✅ Resolvido' : '🔄 Mudou de coluna';
  return { text: `${verb}: ${from}*${escapeMrkdwn(ctx.stageName ?? '-')}*\n${peopleLine(ctx)}` };
}

const EVENT_LABELS = {
  updated: 'Mudou de coluna',
  awaiting: 'Aguardando resposta',
  closed: 'Resolvido',
};

function plainName(person, fallback) {
  return person?.name ?? fallback;
}

// Variáveis mandadas pro fluxo de trabalho (modo webhook — ver
// lib/slack-webhook.js). Só texto puro (o fluxo insere como está);
// `mencoes` leva <@ID> de quem tem usuário do Slack cadastrado na aba
// Agentes.
function buildWebhookVariables(ticketId, ctx) {
  const people = [ctx.creator, ctx.agent, ctx.showCsm ? ctx.csmLabel : null];
  const mentions = [...new Set(people.map((p) => p?.mention).filter(Boolean))];
  return {
    evento: EVENT_LABELS[ctx.kind] ?? EVENT_LABELS.updated,
    ticket: ctx.title ?? '(sem título)',
    coluna: ctx.stageName ?? '',
    coluna_anterior: ctx.previousStageName ?? '',
    prioridade: ctx.priority ?? '',
    cliente: ctx.clientName ?? '',
    jornada: ctx.journeyNames?.join(', ') ?? '',
    criado_por: plainName(ctx.creator, '(sem mapeamento)'),
    responsavel: ctx.agent ? plainName(ctx.agent, '(sem mapeamento)') : '',
    csm: ctx.showCsm ? plainName(ctx.csmLabel, ctx.csm?.name ?? '') : '',
    mencoes: mentions.join(' '),
    link: ctx.publicId ? `${TICKET_BASE_URL}/${ctx.publicId}` : '',
    ticket_id: ctx.publicId != null ? String(ctx.publicId) : ticketId,
  };
}

// Mensagem do ticket num canal: a primeira mudança de coluna cria a
// mensagem-mãe (é ela que aparece no canal e notifica); as seguintes editam
// a mãe e respondem na thread dela — o canal fica com UMA mensagem por
// ticket. Se a mãe foi apagada no Slack, cria outra.
async function sendToChannel(ticketId, channelId, ctx) {
  if (isWebhookTarget(channelId)) {
    await postWorkflowWebhook(channelId, buildWebhookVariables(ticketId, ctx));
    return;
  }

  const parent = buildParentMessage(ctx);
  const rows = await sql`select message_ts from slack_ticket_messages where ticket_id = ${ticketId} and channel_id = ${channelId}`;
  const ts = rows[0]?.message_ts;

  if (ts) {
    try {
      await updateMessage({ channel: channelId, ts, ...parent });
      await postMessage({ channel: channelId, threadTs: ts, ...buildThreadReply(ctx) });
      return;
    } catch (err) {
      if (err.slackError !== 'message_not_found') throw err;
    }
  }

  const sent = await postMessage({ channel: channelId, ...parent });
  await sql`
    insert into slack_ticket_messages (ticket_id, channel_id, message_ts) values (${ticketId}, ${channelId}, ${sent.ts})
    on conflict (ticket_id, channel_id) do update set message_ts = excluded.message_ts
  `;
}

async function resolvePeople({ createdById, agentId, csm }) {
  const [creator, agent, csmLabel] = await Promise.all([
    getPersonLabel(createdById),
    getPersonLabel(agentId),
    getPersonLabel(csm?.id),
  ]);
  return { creator, agent: agentId ? agent ?? { name: null } : null, csmLabel };
}

// Manda a notificação de mudança de coluna pros canais do ticket. Erro num
// canal não derruba os outros.
export async function notifyTicketEvent({ ticketId, people, ...ctx }) {
  const targets = await getTargetChannels(ctx.createdById, ctx.journeyNames);
  if (targets.length === 0) {
    console.warn(`Nenhum canal vinculado ao criador ${ctx.createdById ?? '(?)'} nem à(s) jornada(s) do cliente — ticket "${ctx.title ?? '(sem título)'}" não notificou ninguém.`);
    return;
  }

  const results = await Promise.allSettled(
    targets.map((t) => sendToChannel(ticketId, t.channelId, { ...ctx, ...people, showCsm: t.showCsm }))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Falha ao notificar o canal ${targets[i].channelId}:`, r.reason?.message ?? r.reason);
  });
}

function stageNameOf(stageId, stageLabels) {
  if (!stageId) return null;
  return extractStage({ stageId }, stageLabels).name;
}

function listInfo({ ticket, stage, status, clientName, journeyNames, people }) {
  return {
    ticketId: ticket.id,
    publicId: ticket.publicId ?? null,
    url: ticket.publicId ? `${TICKET_BASE_URL}/${ticket.publicId}` : null,
    title: ticket.title,
    stageName: stage.name,
    status,
    priority: ticket.priority,
    clientName,
    journeyNames,
    creatorSlackId: people.creator?.slackUserId ?? null,
    agentSlackId: people.agent?.slackUserId ?? null,
    csmSlackId: people.csmLabel?.slackUserId ?? null,
  };
}

// Compara um ticket aberto com o snapshot em ticket_state. Só notifica
// MUDANÇA DE COLUNA (stage_id diferente do salvo) — ticket novo só é
// gravado (e ganha linha na Lista), sem mensagem. Cosméticos
// (title/priority/cliente/CSM) sempre são atualizados.
//
// Uma notificação por mudança, mesmo com execuções simultâneas (os crons +
// o botão "Buscar tickets"): a troca de stage_id é um UPDATE condicional que
// trava a linha (`for update`) — só a primeira execução recebe a linha de
// volta; as outras reavaliam depois do commit, veem a coluna já igual e
// não notificam.
//
// `listRowIds`: tickets que já têm linha na Lista (null = Lista não criada);
// `listBudget`: quantas linhas novas essa rodada ainda pode criar.
export async function processTicket(ticket, { stageLabels, clientName, journeyNames, csm, seeding, listRowIds, listBudget }) {
  const stage = extractStage(ticket, stageLabels);
  const clientId = ticket.mainClientId ?? null;

  const previousRows = await sql`select client_name, journey_names, csm_id, csm_name from ticket_state where ticket_id = ${ticket.id}`;
  const previous = previousRows[0];
  const resolvedClientName = clientName ?? previous?.client_name ?? null;
  // journeyNames só vem preenchido quando a sincronização buscou o cliente
  // (ver lib/ticket-sync.js); sem isso preserva o que já estava salvo.
  const resolvedJourneyNames = journeyNames ?? previous?.journey_names ?? null;
  // csm === undefined: cliente não foi buscado, preserva o salvo.
  const resolvedCsm =
    csm !== undefined ? csm : previous?.csm_id || previous?.csm_name ? { id: previous.csm_id, name: previous.csm_name } : null;

  // stage_id fica de fora do "do update" de propósito — quem troca a coluna
  // de um ticket já conhecido é o UPDATE condicional logo abaixo.
  await sql`
    insert into ticket_state (ticket_id, public_id, stage_id, title, priority, client_name, client_id, created_by_id, journey_names, csm_id, csm_name)
    values (${ticket.id}, ${ticket.publicId ?? null}, ${stage.id}, ${ticket.title ?? null}, ${ticket.priority ?? null}, ${resolvedClientName}, ${clientId}, ${ticket.createdById ?? null}, ${resolvedJourneyNames}, ${resolvedCsm?.id ?? null}, ${resolvedCsm?.name ?? null})
    on conflict (ticket_id) do update set
      title = excluded.title,
      priority = excluded.priority,
      client_name = excluded.client_name,
      client_id = excluded.client_id,
      journey_names = excluded.journey_names,
      csm_id = excluded.csm_id,
      csm_name = excluded.csm_name,
      updated_at = now()
  `;

  const moved = await sql`
    update ticket_state t set stage_id = ${stage.id}, updated_at = now()
    from (select ticket_id, stage_id as old_stage_id from ticket_state where ticket_id = ${ticket.id} for update) o
    where t.ticket_id = o.ticket_id and t.stage_id is distinct from ${stage.id}
    returning o.old_stage_id
  `;
  const didMove = moved.length > 0;
  const needsListRow = listRowIds != null && !listRowIds.has(ticket.id);
  if (!didMove && !needsListRow) return { stage, notified: false, kind: null };

  const people = await resolvePeople({ createdById: ticket.createdById, agentId: ticket.agentId, csm: resolvedCsm });
  const status = stage.isAwaitingResponseStage ? 'aguardando' : 'aberto';
  const info = listInfo({ ticket, stage, status, clientName: resolvedClientName, journeyNames: resolvedJourneyNames, people });

  if (!didMove) {
    await upsertTicketRow(info, { budget: listBudget });
    return { stage, notified: false, kind: null };
  }

  await upsertTicketRow(info);
  if (seeding) return { stage, notified: false, kind: 'updated' };

  await notifyTicketEvent({
    ticketId: ticket.id,
    people,
    kind: stage.isAwaitingResponseStage ? 'awaiting' : 'updated',
    title: ticket.title,
    priority: ticket.priority,
    publicId: ticket.publicId,
    clientName: resolvedClientName,
    stageName: stage.name,
    previousStageName: stageNameOf(moved[0].old_stage_id, stageLabels),
    createdById: ticket.createdById,
    journeyNames: resolvedJourneyNames,
    csm: resolvedCsm,
  });
  return { stage, notified: true, kind: 'updated' };
}

// Chamado no lugar de processTicket() sempre que o ticket estiver fechado
// (coluna de encerramento — stage_labels.is_closed_stage — ou status
// CLOSED/CANCELLED, ver isClosed em lib/ticket-sync.js). Remove a linha do
// ticket_state, marca Status = Resolvido na Lista e só notifica se o ticket
// MUDOU DE COLUNA pra chegar aí — fechado só pelo status, na mesma coluna,
// sai em silêncio. O `delete ... returning` é atômico: com execuções
// simultâneas só uma recebe a linha, então sai no máximo uma mensagem.
export async function processClosedTicket(ticket, { stageLabels, seeding }) {
  const deletedRows = await sql`
    delete from ticket_state where ticket_id = ${ticket.id}
    returning stage_id, client_id, client_name, journey_names, csm_id, csm_name
  `;
  const previous = deletedRows[0];
  if (!previous) return { notified: false, kind: null };

  // CSM sem valor no ticket_state (linha anterior ao recurso de CSM) cai no
  // cache client_names, que a sincronização mantém em dia.
  let csmId = previous.csm_id;
  let csmName = previous.csm_name;
  if (!csmId && !csmName && previous.client_id) {
    const cached = await sql`select csm_id, csm_name from client_names where client_id = ${previous.client_id}`;
    csmId = cached[0]?.csm_id ?? null;
    csmName = cached[0]?.csm_name ?? null;
  }
  const csm = csmId || csmName ? { id: csmId, name: csmName } : null;

  const stage = extractStage(ticket, stageLabels);
  const people = await resolvePeople({ createdById: ticket.createdById, agentId: ticket.agentId, csm });
  await upsertTicketRow(
    listInfo({ ticket, stage, status: 'resolvido', clientName: previous.client_name, journeyNames: previous.journey_names, people }),
    { onlyExisting: true }
  );

  if (seeding || previous.stage_id === stage.id) return { notified: false, kind: 'closed' };

  await notifyTicketEvent({
    ticketId: ticket.id,
    people,
    kind: 'closed',
    title: ticket.title,
    priority: ticket.priority,
    publicId: ticket.publicId,
    clientName: previous.client_name,
    stageName: stage.name,
    previousStageName: stageNameOf(previous.stage_id, stageLabels),
    createdById: ticket.createdById,
    journeyNames: previous.journey_names,
    csm,
  });
  return { notified: true, kind: 'closed' };
}
