import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { slugifyCommand } from '../lib/journey-groups.js';

async function handleChats(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`
      select
        c.chat_id, c.label, c.active, c.thread_id, c.is_personal, c.created_at,
        coalesce(
          json_agg(distinct a.softcs_user_id) filter (where a.softcs_user_id is not null),
          '[]'
        ) as member_ids,
        -- só populado quando is_personal (uma inscrição via /status sempre tem
        -- exatamente um membro, o próprio dono do chat) — nome pra exibir na UI
        -- em vez do chat_id cru, ver aba Chats.
        max(am.display_name) filter (where c.is_personal) as agent_display_name,
        -- grupos de jornada seguidos (aba Jornadas / comando dinâmico no bot)
        -- — distinto de member_ids/chat_agents (roteamento por criador).
        coalesce(
          json_agg(distinct g.name) filter (where g.name is not null),
          '[]'
        ) as journey_group_names
      from telegram_chats c
      left join chat_agents a on a.chat_id = c.chat_id
      left join agent_mapping am on am.softcs_user_id = a.softcs_user_id
      left join chat_journey_groups cg on cg.chat_id = c.chat_id
      left join journey_groups g on g.command = cg.command
      group by c.chat_id, c.label, c.active, c.thread_id, c.is_personal, c.created_at
      order by c.created_at desc
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { chat_id, label, member_ids, thread_id } = req.body ?? {};
    if (!chat_id) {
      res.status(400).json({ error: 'chat_id é obrigatório' });
      return;
    }

    await sql`
      insert into telegram_chats (chat_id, label, active, thread_id)
      values (${String(chat_id)}, ${label || null}, true, ${thread_id ? String(thread_id) : null})
      on conflict (chat_id) do update set label = excluded.label, active = true, thread_id = excluded.thread_id
    `;

    if (Array.isArray(member_ids)) {
      await sql`delete from chat_agents where chat_id = ${String(chat_id)}`;
      for (const softcsUserId of member_ids) {
        await sql`
          insert into chat_agents (chat_id, softcs_user_id)
          values (${String(chat_id)}, ${softcsUserId})
          on conflict do nothing
        `;
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'PATCH') {
    const { chat_id, active } = req.body ?? {};
    if (!chat_id || typeof active !== 'boolean') {
      res.status(400).json({ error: 'chat_id e active são obrigatórios' });
      return;
    }
    await sql`update telegram_chats set active = ${active} where chat_id = ${String(chat_id)}`;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const chatId = req.query.chat_id;
    if (!chatId) {
      res.status(400).json({ error: 'chat_id é obrigatório' });
      return;
    }
    await sql`delete from telegram_chats where chat_id = ${chatId}`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

// CRUD dos grupos de jornada (aba Jornadas) — junta várias jornadas sob um
// nome, e esse nome vira um comando de verdade no bot (/{command}, ver
// api/telegram-webhook.js). Consolidado aqui (via ?action=groups, reescrito
// de /api/journey-groups pelo vercel.json) em vez de um arquivo próprio
// porque o projeto já está no limite de 12 Serverless Functions do plano
// Hobby da Vercel — ver README.
async function handleJourneyGroups(req, res) {
  if (req.method === 'GET') {
    const groups = await sql`
      select
        g.command, g.name, g.created_at,
        coalesce(
          json_agg(distinct i.journey_name) filter (where i.journey_name is not null),
          '[]'
        ) as journey_names,
        count(distinct cg.chat_id) as subscriber_count
      from journey_groups g
      left join journey_group_items i on i.command = g.command
      left join chat_journey_groups cg on cg.command = g.command
      group by g.command, g.name, g.created_at
      order by g.created_at desc
    `;
    // Jornadas com ticket aberto rastreado agora — alimenta o multi-select
    // de "quais jornadas entram nesse grupo" no formulário (aba Jornadas);
    // só existe o que a fase de descoberta já viu (ver lib/ticket-scan.js).
    const known = await sql`
      select distinct unnest(journey_names) as name from ticket_state where journey_names is not null order by 1
    `;
    res.status(200).json({ groups, knownJourneyNames: known.map((r) => r.name) });
    return;
  }

  // Mapeamento automático: cria um grupo 1:1 (nome = nome da jornada) pra
  // cada jornada conhecida (ticket_state.journey_names) que ainda não
  // pertence a NENHUM grupo existente — não mexe em jornadas que já foram
  // agrupadas manualmente (junto com outras, ou renomeadas), só preenche o
  // que falta. Pedido explícito, pra não precisar cadastrar uma por uma
  // quando são várias.
  if (req.method === 'POST' && req.body?.auto_map) {
    const known = await sql`
      select distinct unnest(journey_names) as name from ticket_state where journey_names is not null order by 1
    `;
    const covered = await sql`select distinct journey_name from journey_group_items`;
    const coveredSet = new Set(covered.map((r) => r.journey_name));

    const created = [];
    const skipped = [];
    for (const journeyName of known.map((r) => r.name)) {
      if (coveredSet.has(journeyName)) continue; // já está em algum grupo, não mexe
      const command = slugifyCommand(journeyName);
      if (!command) {
        skipped.push({ name: journeyName, reason: 'nome não vira comando válido' });
        continue;
      }
      const clash = await sql`select 1 from journey_groups where command = ${command}`;
      if (clash.length > 0) {
        skipped.push({ name: journeyName, reason: `comando /${command} já existe (colisão de nome)` });
        continue;
      }
      await sql`insert into journey_groups (command, name) values (${command}, ${journeyName})`;
      await sql`insert into journey_group_items (command, journey_name) values (${command}, ${journeyName})`;
      created.push({ command, name: journeyName });
    }

    res.status(200).json({ ok: true, created, skipped });
    return;
  }

  if (req.method === 'POST') {
    const { command: existingCommand, name, journey_names: journeyNames } = req.body ?? {};
    if (!name || !Array.isArray(journeyNames) || journeyNames.length === 0) {
      res.status(400).json({ error: 'name e journey_names (pelo menos uma) são obrigatórios' });
      return;
    }
    const command = slugifyCommand(name);
    if (!command) {
      res.status(400).json({ error: 'Não deu pra gerar um comando válido a partir desse nome' });
      return;
    }

    // Nome mudou o suficiente pra mudar o comando (slug) — UPDATE na PK em
    // vez de INSERT/DELETE, pra `on update cascade` levar junto as jornadas
    // e inscrições já cadastradas nesse grupo (ver schema.sql).
    if (existingCommand && existingCommand !== command) {
      const clash = await sql`select 1 from journey_groups where command = ${command}`;
      if (clash.length > 0) {
        res.status(400).json({ error: `Já existe um grupo com o comando /${command} — escolha outro nome.` });
        return;
      }
      await sql`update journey_groups set command = ${command}, name = ${name} where command = ${existingCommand}`;
    } else {
      await sql`
        insert into journey_groups (command, name) values (${command}, ${name})
        on conflict (command) do update set name = excluded.name
      `;
    }

    await sql`delete from journey_group_items where command = ${command}`;
    for (const journeyName of journeyNames) {
      await sql`
        insert into journey_group_items (command, journey_name) values (${command}, ${journeyName})
        on conflict do nothing
      `;
    }

    res.status(200).json({ ok: true, command });
    return;
  }

  if (req.method === 'DELETE') {
    const command = req.query.command;
    if (!command) {
      res.status(400).json({ error: 'command é obrigatório' });
      return;
    }
    await sql`delete from journey_groups where command = ${command}`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.query.action === 'groups') return handleJourneyGroups(req, res);
  return handleChats(req, res);
}
