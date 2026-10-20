  -- Mapeamento: usuário SoftCS (createdById) -> nome/e-mail (via importação em
  -- lote de /admin.html, colando a lista de usuários) e @username do Telegram
  -- (preenchido depois, manualmente — a SoftCS não expõe isso em lugar nenhum).
  create table if not exists agent_mapping (
    softcs_user_id text primary key,
    telegram_username text,
    display_name text,
    email text,
    updated_at timestamptz not null default now()
  );

  -- Caso a tabela já existisse de uma versão anterior com telegram_username not null.
  alter table agent_mapping alter column telegram_username drop not null;
  alter table agent_mapping add column if not exists email text;

  -- Dedupe: evita reenviar a mesma mensagem no Telegram se a SoftCS reenviar o mesmo evento
  -- (retry de webhook por timeout, por exemplo).
  create table if not exists processed_webhook_events (
    event_id text primary key,
    received_at timestamptz not null default now()
  );

  -- Grupos/canais do Telegram que devem receber a notificação de cada ticket novo.
  -- Também usada pra chats privados (DM) individuais — ver comando /status em
  -- api/telegram-webhook.js: chat_id de uma conversa privada é o mesmo que o
  -- user id da pessoa no Telegram, então funciona igual a um chat de grupo.
  create table if not exists telegram_chats (
    chat_id text primary key,
    label text,
    active boolean not null default true,
    created_at timestamptz not null default now()
  );

  -- thread_id de um Tópico específico dentro de um grupo em modo fórum (ver
  -- seção "Tópicos" do Telegram) — quando preenchido, a notificação vai só
  -- pra esse tópico (Bot API: message_thread_id), não pro grupo inteiro.
  -- Descoberto manualmente (ver README) porque a API do Telegram não lista
  -- tópicos existentes, só devolve o id quando alguém posta neles.
  alter table telegram_chats add column if not exists thread_id text;

  -- true só pra chats criados pelo comando /status (DM pessoal de um agente
  -- com o bot — ver api/telegram-webhook.js), pra diferenciar visualmente na
  -- aba Chats de um grupo/canal cadastrado à mão. Nunca marcado manualmente.
  alter table telegram_chats add column if not exists is_personal boolean not null default false;

  -- Credenciais da aplicação OAuth2 da SoftCS, usadas pela busca "Buscar tickets".
  create table if not exists settings (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
  );

  -- access_token/refresh_token do OAuth da SoftCS. Linha única (id sempre 1).
  create table if not exists softcs_oauth_tokens (
    id integer primary key default 1,
    access_token text not null,
    refresh_token text,
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    constraint single_row check (id = 1)
  );

  -- Caso a tabela já existisse de uma versão anterior com refresh_token not null.
  alter table softcs_oauth_tokens alter column refresh_token drop not null;

  -- Trava pra renovação de token não rodar em paralelo (ver getValidAccessToken
  -- em lib/softcs-api.js) — cada renovação bem-sucedida invalida o
  -- refresh_token anterior (rotação), então duas chamadas concorrentes
  -- renovando ao mesmo tempo faziam uma "perder a corrida" e gravar por cima
  -- um token já obsoleto, quebrando a conexão (invalid_grant na próxima vez).
  alter table softcs_oauth_tokens add column if not exists refreshing_since timestamptz;

  -- Estado temporário do fluxo OAuth (Authorization Code + PKCE).
  create table if not exists oauth_pkce_state (
    state text primary key,
    code_verifier text not null,
    created_at timestamptz not null default now()
  );

  -- Nome amigável e posição pra cada coluna do Kanban (stageId), preenchidos
  -- manualmente no painel — a API pública da SoftCS (a que a gente usa,
  -- autenticada via OAuth) não devolve nome nem posição do estágio, só o ID
  -- (confirmado ao vivo: `denormalizedStage`/`stage` vêm sempre `undefined`
  -- nela; só o endpoint interno de sessão do navegador tem isso, fora do
  -- nosso alcance). `position` controla a ordem das colunas no nosso Kanban
  -- (menor aparece primeiro); sem valor definido, a coluna cai no fim
  -- (fallback 999 em extractStage()).
  create table if not exists stage_labels (
    stage_id text primary key,
    label text not null,
    position integer,
    updated_at timestamptz not null default now()
  );

  alter table stage_labels add column if not exists position integer;

  -- true pra estágios do tipo "encerrado" (ex: Resolvido, Resolvido por
  -- Inatividade) — controla se um ticket que cai aqui é tratado como fechado
  -- (processClosedTicket() em lib/ticket-notify.js: notifica "resolvido" e sai
  -- do Kanban de abertos) em vez de aberto normal. NÃO usa `ticket.closedAt`
  -- da API pra decidir isso — confirmado ao vivo que a SoftCS não limpa esse
  -- campo quando um ticket é reaberto (fica com a data do fechamento antigo
  -- pra sempre, mesmo com o ticket de volta numa coluna normal e ativa), então
  -- esse campo sozinho não é confiável pra saber se o ticket está fechado
  -- *agora*. Configurado manualmente ao renomear a coluna (aba Tickets).
  alter table stage_labels add column if not exists is_closed_stage boolean not null default false;

  -- Marca a(s) coluna(s) do Kanban que representam a fila "Aguardando
  -- Resposta" (mesma convenção de is_closed_stage: clique no nome da coluna,
  -- aba Tickets). Dá pra marcar mais de uma, se houver mais de uma fila de
  -- espera — todas entram na checagem do lembrete diário (/resposta, ver
  -- lib/awaiting-response.js).
  alter table stage_labels add column if not exists is_awaiting_response_stage boolean not null default false;

  -- Quais agentes pertencem a cada chat do Telegram. Usado pelo webhook pra
  -- mandar a notificação de um ticket só pro(s) chat(s) onde o criador é
  -- membro — é o único jeito da @menção realmente notificar alguém no Telegram
  -- (só funciona se a pessoa estiver no grupo).
  create table if not exists chat_agents (
    chat_id text not null references telegram_chats (chat_id) on delete cascade,
    softcs_user_id text not null references agent_mapping (softcs_user_id) on delete cascade,
    primary key (chat_id, softcs_user_id)
  );

  -- Login do painel: Google OAuth restrito a e-mails @chatbotmaker.io e só quem
  -- estiver nesta lista (ver lib/auth.js). lucasrodrigues@chatbotmaker.io é o
  -- master fixo — o código trata esse e-mail como master mesmo se a linha for
  -- removida por engano, mas ele fica registrado aqui também por clareza.
  create table if not exists allowed_users (
    email text primary key,
    display_name text,
    added_by text,
    created_at timestamptz not null default now()
  );

  insert into allowed_users (email, display_name)
  values ('lucasrodrigues@chatbotmaker.io', 'Lucas Rodrigues (master)')
  on conflict (email) do nothing;

  -- Sessões do painel (cookie opaco -> linha). Sem JWT/assinatura: valida
  -- sempre com uma consulta ao banco, como o resto do projeto já faz com
  -- oauth_pkce_state.
  create table if not exists sessions (
    token text primary key,
    email text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  );

  -- Estado anti-CSRF do fluxo de login com o Google (mesmo padrão do
  -- oauth_pkce_state usado no OAuth da SoftCS).
  create table if not exists google_oauth_state (
    state text primary key,
    created_at timestamptz not null default now()
  );

  -- Snapshot do último estado conhecido de cada ticket aberto, usado por
  -- api/poll-tickets.js pra detectar o que mudou entre uma varredura e outra
  -- (a SoftCS não tem webhook de ticket — ver nota em api/webhook.js) E como
  -- fonte do Kanban da aba Tickets (api/discover-tickets.js?source=stored) —
  -- assim o board fica salvo/visível sem precisar rodar uma busca ao vivo toda
  -- vez que a página carrega, só mudando quando o polling detectar algo de
  -- verdade. Um ticket sem linha aqui é "novo" (dispara notificação de
  -- criação); um ticket cujo stage_id mudou desde a última varredura é
  -- "atualizado" (dispara notificação de movimentação). title/priority/
  -- client_name são só cosméticos (mantidos frescos a cada varredura, não
  -- entram na decisão de notificar). Um ticket com closedAt preenchido que
  -- tinha linha aqui dispara "resolvido" (processClosedTicket() em
  -- lib/ticket-notify.js) e a linha é removida — deixa de existir pro Kanban
  -- de abertos, não fica órfã.
  create table if not exists ticket_state (
    ticket_id text primary key,
    public_id text,
    stage_id text,
    title text,
    priority text,
    client_name text,
    client_id text,
    created_by_id text,
    updated_at timestamptz not null default now()
  );

  alter table ticket_state add column if not exists priority text;
  alter table ticket_state add column if not exists client_name text;
  -- client_id: mainClientId do ticket (usado pra buscar nome/jornada do
  -- cliente — ver lib/ticket-sync.js).
  alter table ticket_state add column if not exists client_id text;

  -- Nomes das jornadas (Customer Success) que o cliente dono do ticket está
  -- em cada uma — a API pública devolve isso já pronto por cliente
  -- (`GET /clients` -> `journeys[].journeyName`, sem precisar mapear ID pra
  -- nome como acontece com stageId). Atualizado pela sincronização
  -- (lib/ticket-sync.js) quando o ticket é novo, muda de coluna ou ainda não
  -- tem nome de cliente salvo — nos outros casos preserva o valor já salvo
  -- em vez de apagar. Usado por getTargetChatIds() em
  -- lib/ticket-notify.js pra rotear notificação pros chats inscritos numa
  -- jornada (ver chat_journeys), além do roteamento por criador que já existia.
  alter table ticket_state add column if not exists journey_names text[];

  -- CSM responsável pelo cliente dono do ticket (`GET /clients/{id}` ->
  -- `csm: { id, name }`), atualizado junto com journey_names. Só aparece na
  -- notificação mandada pros chats que recebem o ticket pelo grupo /ka (ver
  -- CSM_JOURNEY_GROUP em lib/ticket-notify.js) — @menção quando csm_id está
  -- na aba Agentes com @username, senão o nome.
  alter table ticket_state add column if not exists csm_id text;
  alter table ticket_state add column if not exists csm_name text;

  -- Grupo de jornadas cadastrado no painel (aba Jornadas): junta várias
  -- jornadas sob um nome só, e esse nome vira um comando de verdade no bot
  -- (ex: grupo "Onboarding Ativo" -> comando /onboarding_ativo). `command` é
  -- o slug gerado a partir de `name` (minúsculo, sem acento, só
  -- [a-z0-9_] — ver slugifyCommand() em lib/journey-groups.js) e é a chave
  -- primária porque É o texto que a pessoa digita/toca no Telegram; não faz
  -- sentido dois grupos colidirem no mesmo comando.
  create table if not exists journey_groups (
    command text primary key,
    name text not null,
    created_at timestamptz not null default now()
  );

  -- Grupo "pega-tudo": quem segue um grupo com is_catch_all = true recebe
  -- TODO ticket criado/atualizado/resolvido, de qualquer cliente e qualquer
  -- criador — inclusive os que não batem com nenhum criador mapeado (chat_agents)
  -- nem com nenhuma jornada de nenhum grupo normal. Ignora journey_group_items
  -- (não precisa de nenhuma jornada selecionada). Pedido explícito do usuário
  -- em 2026-09-14: diferente do fallback "notifica todo chat cadastrado" que
  -- foi removido de propósito após um vazamento real (ver getTargetChatIds em
  -- lib/ticket-notify.js), este é opt-in por chat — só quem SEGUE esse grupo
  -- específico recebe tudo; os demais chats continuam sem fallback nenhum.
  alter table journey_groups add column if not exists is_catch_all boolean not null default false;

  -- Quais jornadas pertencem a cada grupo (N:N) — journey_name é o texto
  -- exatamente como aparece em ticket_state.journey_names. `on update cascade`
  -- porque renomear um grupo muda `command` (é derivado do nome — ver
  -- slugifyCommand em lib/journey-groups.js), e isso precisa propagar sem
  -- perder os vínculos já cadastrados.
  create table if not exists journey_group_items (
    command text not null references journey_groups (command) on delete cascade on update cascade,
    journey_name text not null,
    primary key (command, journey_name)
  );

  -- Inscrição de um chat (DM pessoal — a pessoa toca/digita o comando do
  -- grupo no bot) num grupo de jornadas: todo ticket cujo cliente esteja em
  -- QUALQUER jornada do grupo notifica esse chat, além do roteamento por
  -- criador que já existia (chat_agents). Ver getTargetChatIds() em
  -- lib/ticket-notify.js e o handler de comando dinâmico em
  -- api/telegram-webhook.js.
  create table if not exists chat_journey_groups (
    chat_id text not null references telegram_chats (chat_id) on delete cascade,
    command text not null references journey_groups (command) on delete cascade on update cascade,
    primary key (chat_id, command)
  );

  -- Cache de nome de cliente, só pra exibição das colunas de encerramento no
  -- Kanban (api/discover-tickets.js?source=closed) e da exportação
  -- (api/export-tickets.js) — ver lib/client-names.js. A busca de tickets não
  -- traz o nome do cliente e listar /clients inteiro custa ~44 chamadas
  -- (~8.7 mil clientes, medido ao vivo), então cada carregamento busca só um
  -- lote dos que ainda faltam (GET /clients/{id}) e grava aqui.
  create table if not exists client_names (
    client_id text primary key,
    name text,
    updated_at timestamptz not null default now()
  );

  -- Resto do que o GET /clients/{id} devolve e a busca de tickets não traz,
  -- pra view ticket_export: jornadas ativas (array JSON de nomes, mesmo
  -- critério de ticket_state.journey_names) e CSM. info_updated_at = quando
  -- essas colunas foram buscadas — null nas linhas antigas, que só tinham o
  -- nome; vencido (24h) ou null, o cliente é buscado de novo (ver
  -- resolveClientNames em lib/client-names.js).
  alter table client_names add column if not exists journey_names jsonb;
  alter table client_names add column if not exists csm_id text;
  alter table client_names add column if not exists csm_name text;
  alter table client_names add column if not exists info_updated_at timestamptz;

  -- Inscrição pessoal no lembrete diário de tickets "Aguardando Resposta"
  -- parados (comando /resposta no privado do bot — liga/desliga, igual aos
  -- comandos de grupo de jornada — ver api/telegram-webhook.js). Independente
  -- de chat_agents/chat_journey_groups: não é sobre ticket novo ou que mudou
  -- de coluna, é um resumo diário às 09:00 só pra quem pediu (ver
  -- lib/awaiting-response.js).
  alter table telegram_chats add column if not exists awaiting_response_subscribed boolean not null default false;

  -- Cópia de TODOS os tickets da conta (abertos e encerrados), mantida pelo
  -- polling (lib/ticket-snapshot.js) e lida pela exportação
  -- (/api/export-tickets, consumida pelo Metricas-CS) sem chamar a SoftCS.
  -- `data` é o ticket cru da API (descrição já em texto puro); nomes de
  -- coluna/agente/cliente são resolvidos na hora da exportação, pra renomear
  -- uma coluna ou cadastrar um agente valer na hora, sem re-sincronizar.
  create table if not exists ticket_snapshot (
    ticket_id text primary key,
    data jsonb not null,
    softcs_updated_at timestamptz,
    synced_at timestamptz not null default now()
  );

  -- Todos os tickets com tudo que a busca na SoftCS trouxe + os nomes que ela
  -- não traz, já resolvidos — pra outro sistema (ex: Metricas-CS) consultar o
  -- banco direto, sem passar pela exportação HTTP. Mesmos critérios de
  -- lib/export-tickets.js: coluna por stage_labels (sem label = "Coluna #"
  -- + fim do id), agente/criador por agent_mapping, cliente por client_names
  -- (ou ticket_state), e "resolvido" = coluna de encerramento ou status
  -- diferente de OPEN. Jornada/CSM vêm de ticket_state pros tickets abertos
  -- (mais recente) e de client_names pros demais. `data` = ticket cru, com
  -- campos que a API venha a acrescentar. É view (não tabela) pra renomear
  -- coluna ou cadastrar agente valer na hora.
  create or replace view ticket_export as
  select
    s.ticket_id as id,
    s.data->>'publicId' as public_id,
    coalesce(s.data->>'title', '') as title,
    coalesce(s.data->>'description', '') as description,
    coalesce(s.data->>'descriptionHtml', '') as description_html,
    s.data->>'stageId' as stage_id,
    case
      when sl.label is not null then sl.label
      when s.data->>'stageId' is null then 'Sem estágio'
      else 'Coluna #' || right(s.data->>'stageId', 4)
    end as stage_name,
    sl.position as stage_position,
    coalesce(sl.is_closed_stage, false) as is_closed_stage,
    coalesce(sl.is_awaiting_response_stage, false) as is_awaiting_response_stage,
    s.data->>'status' as status,
    coalesce(sl.is_closed_stage, false) or coalesce(s.data->>'status' <> 'OPEN', false) as resolved,
    s.data->>'priority' as priority,
    s.data->>'escalationTier' as escalation_tier,
    (s.data->>'slaHours')::numeric as sla_hours,
    s.data->>'agentId' as agent_id,
    coalesce(ag.display_name, ag.email) as agent_name,
    s.data->>'createdById' as created_by_id,
    coalesce(cb.display_name, cb.email) as created_by_name,
    c.client_id,
    coalesce(cn.name, ts.client_name) as client_name,
    coalesce(
      ts.journey_names,
      (select array_agg(j) from jsonb_array_elements_text(cn.journey_names) j)
    ) as client_journey_names,
    coalesce(ts.csm_id, cn.csm_id) as csm_id,
    coalesce(ts.csm_name, cn.csm_name) as csm_name,
    array(select jsonb_array_elements_text(coalesce(s.data->'clientIds', '[]'))) as client_ids,
    array(select jsonb_array_elements_text(coalesce(s.data->'contactIds', '[]'))) as contact_ids,
    s.data->>'jiraIssueId' as jira_issue_id,
    (s.data->>'visibleToCustomer')::boolean as visible_to_customer,
    'https://admin.softcs.com.br/pt-br/tickets/' || (s.data->>'publicId') as url,
    (s.data->>'createdAt')::timestamptz as created_at,
    (s.data->>'updatedAt')::timestamptz as updated_at,
    (s.data->>'closedAt')::timestamptz as closed_at,
    (s.data->>'canceledAt')::timestamptz as canceled_at,
    s.synced_at,
    s.data
  from ticket_snapshot s
  cross join lateral (select coalesce(s.data->>'mainClientId', s.data->'clientIds'->>0) as client_id) c
  left join stage_labels sl on sl.stage_id = s.data->>'stageId'
  left join agent_mapping ag on ag.softcs_user_id = s.data->>'agentId'
  left join agent_mapping cb on cb.softcs_user_id = s.data->>'createdById'
  left join client_names cn on cn.client_id = c.client_id
  left join ticket_state ts on ts.ticket_id = s.ticket_id;
