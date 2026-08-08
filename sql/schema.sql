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
