-- Mapeamento manual: usuário SoftCS (createdById) -> @username do Telegram.
-- Preencher à mão em /admin.html, um registro por pessoa, à medida que os IDs
-- forem descobertos (a API pública da SoftCS não expõe uma lista de agentes).
create table if not exists agent_mapping (
  softcs_user_id text primary key,
  telegram_username text not null,
  display_name text,
  updated_at timestamptz not null default now()
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
