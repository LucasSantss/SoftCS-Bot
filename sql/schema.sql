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
-- client_id: precisa pra api/poll-tickets.js?phase=known re-consultar
-- diretamente o cliente de cada ticket já conhecido (fase prioritária, ver
-- nota em api/poll-tickets.js), sem depender de reencontrar o cliente numa
-- varredura completa da conta.
alter table ticket_state add column if not exists client_id text;
