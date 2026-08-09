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
create table if not exists telegram_chats (
  chat_id text primary key,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

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

-- Estado temporário do fluxo OAuth (Authorization Code + PKCE).
create table if not exists oauth_pkce_state (
  state text primary key,
  code_verifier text not null,
  created_at timestamptz not null default now()
);

-- Nome amigável pra cada coluna do Kanban (stageId), preenchido manualmente no
-- painel — a API pública da SoftCS não retorna o nome do estágio, só o ID.
create table if not exists stage_labels (
  stage_id text primary key,
  label text not null,
  updated_at timestamptz not null default now()
);

-- Quais agentes pertencem a cada chat do Telegram. Usado pelo webhook pra
-- mandar a notificação de um ticket só pro(s) chat(s) onde o criador é
-- membro — é o único jeito da @menção realmente notificar alguém no Telegram
-- (só funciona se a pessoa estiver no grupo).
create table if not exists chat_agents (
  chat_id text not null references telegram_chats (chat_id) on delete cascade,
  softcs_user_id text not null references agent_mapping (softcs_user_id) on delete cascade,
  primary key (chat_id, softcs_user_id)
);
