-- Mapeamento manual: usuário SoftCS (createdById/agentId) -> @username do Telegram.
-- Preencher à mão, um registro por pessoa, à medida que os IDs forem descobertos.
create table if not exists agent_mapping (
  softcs_user_id text primary key,
  telegram_username text not null,
  display_name text,
  updated_at timestamptz not null default now()
);

-- Guarda o par access_token/refresh_token do OAuth da SoftCS.
-- Linha única (id sempre 1); o token é renovado automaticamente antes de expirar.
create table if not exists softcs_oauth_tokens (
  id integer primary key default 1,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

-- Dedupe: evita reenviar a mesma mensagem no Telegram se a SoftCS reenviar o mesmo evento
-- (retry de webhook por timeout, por exemplo).
create table if not exists processed_webhook_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

-- Grupos/canais do Telegram que devem receber a notificação de cada ticket novo.
-- Gerenciado pela página /admin.html.
create table if not exists telegram_chats (
  chat_id text primary key,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Estado temporário do fluxo OAuth (Authorization Code + PKCE), usado só entre
-- /api/oauth-start e /api/oauth-callback. Substitui cookies, que não sobrevivem
-- a redirecionamentos entre domínios diferentes da Vercel (produção vs preview).
-- Linhas somem sozinhas (ver limpeza por expiração em lib/softcs.js).
create table if not exists oauth_pkce_state (
  state text primary key,
  code_verifier text not null,
  created_at timestamptz not null default now()
);

-- Configuração da integração, editável pelo /admin.html: credenciais OAuth da
-- SoftCS e o secret do webhook. Único lugar de configuração além de
-- DATABASE_URL e TELEGRAM_BOT_TOKEN (esses dois continuam como env var, por
-- serem necessários antes de qualquer consulta ao banco ser possível).
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
