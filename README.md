# SoftCS → Telegram

Recebe eventos de ticket via webhook da SoftCS e posta um resumo em um ou mais chats do
Telegram, mencionando quem criou o ticket (`@username`), usando um mapeamento manual entre
o ID de usuário da SoftCS e o `@username` no Telegram.

Só existem duas variáveis de ambiente: `DATABASE_URL` e `TELEGRAM_BOT_TOKEN`. Tudo o mais
(credenciais OAuth2 da SoftCS, mapeamento de agentes, chats do Telegram) é cadastrado
depois do deploy em `/admin.html`, e fica salvo no Neon.

> ⚠️ **`/admin.html` não tem senha nenhuma** — foi uma escolha deliberada (uso pessoal, sem
> fricção de login). Qualquer pessoa com a URL consegue ver e editar tudo por lá, incluindo
> o `client_secret` da SoftCS. Não divulgue essa URL; se isso passar a incomodar, dá pra
> reintroduzir autenticação depois.

> ⚠️ **Pendência conhecida**: o parser em [api/webhook.js](api/webhook.js) foi escrito
> com um formato de payload provisório (`{ event, eventId, data: { ... } }`), pois a
> documentação pública da SoftCS não descreve o corpo do webhook — só a tela de
> configuração dentro do painel mostra isso. Assim que você tiver um evento de teste
> real (o painel geralmente tem um botão "enviar teste"), ajuste `parseEvent()` em
> `api/webhook.js` para bater com os campos reais.

## Por que não existe uma lista automática de agentes

A API pública da SoftCS não tem um recurso `users`/`agents` — só
`GET /oauth/userinfo`, que devolve apenas quem autorizou a integração. O ticket só
traz `createdById` e `agentId` (IDs opacos, sem nome/e-mail). Por isso o mapeamento
é preenchido à mão em `/admin.html`: abra os tickets na SoftCS, identifique quem é o
criador de cada um, pegue o ID correspondente (ex: chamando `GET /clients/{clientId}/tickets/{ticketId}`
uma vez para cada pessoa) e cadastre lá.

## Setup

### 1. Banco (Neon)

Crie um projeto em [neon.tech](https://neon.tech), pegue a connection string e rode
o conteúdo de [sql/schema.sql](sql/schema.sql) (SQL Editor do Neon ou `psql`).

### 2. Variáveis de ambiente

Só estas duas, tanto no `.env` local quanto no painel do projeto na Vercel:

- `DATABASE_URL` — connection string do Neon
- `TELEGRAM_BOT_TOKEN` — token do bot, criado com [@BotFather](https://t.me/BotFather)

### 3. Deploy

```bash
npm install
npx vercel        # ou: conectar o repo pela dashboard da Vercel
```

### 4. Configurar tudo em /admin.html

Acesse `https://SEU-DOMINIO.vercel.app/admin.html`.

Na aba **Configurações**, preencha:

- **Client ID** / **Client Secret** — da aplicação OAuth2 criada em Configurações >
  Aplicações no painel da SoftCS.
- **Redirect URI** — `https://SEU-DOMINIO.vercel.app/api/oauth-callback` (precisa ser
  exatamente o mesmo valor cadastrado na aplicação OAuth2 da SoftCS).
- **Webhook secret** (opcional) — só se a tela de Webhooks da SoftCS tiver esse campo.

Clique em **Salvar configurações** e depois em **Autorizar no SoftCS** — isso conclui o
fluxo OAuth2 (Authorization Code + PKCE) e salva o token no Neon. Os próximos refreshes
são automáticos (`lib/softcs.js`).

Nas abas **Agentes** e **Chats**, cadastre:

- Cada agente: ID do usuário na SoftCS → `@username` no Telegram.
- Cada grupo/canal que deve receber as notificações: descubra o `chat_id` enviando uma
  mensagem no grupo (com o bot já adicionado) e acessando
  `https://api.telegram.org/bot<TOKEN>/getUpdates` — o `chat.id` aparece no JSON
  (grupos costumam ter id negativo).

> **Importante sobre a menção `@username`**: o Telegram só notifica a pessoa se ela
> (a) tiver um `@username` público configurado e (b) for membro do chat/grupo onde o
> bot posta. Se a pessoa não estiver no grupo, o `@username` aparece como texto/link
> mas ninguém é notificado.

### 5. Cadastrar o webhook na SoftCS

No painel da SoftCS (tela de Webhooks), cadastre:

- URL: `https://SEU-DOMINIO.vercel.app/api/webhook`
- Evento: criação de ticket
- Secret (se houver o campo): mesmo valor salvo em "Webhook secret" no `/admin.html`

Dispare o evento de teste, se existir, e confira no log da Vercel (`vercel logs`)
o corpo recebido — ajuste `parseEvent()` em `api/webhook.js` conforme o formato real.

## Rodando localmente

```bash
npm install
npm run dev        # sobe em http://localhost:3000, sem precisar de `vercel login`
```

Usa `node --env-file=.env`, então só precisa do `.env` com `DATABASE_URL` e
`TELEGRAM_BOT_TOKEN`. Se for testar o fluxo de autorização OAuth2 localmente, cadastre
`http://localhost:3000/api/oauth-callback` como Redirect URI tanto em `/admin.html`
quanto na aplicação OAuth2 da SoftCS.

## Estrutura

```
admin.html            painel único (sem login): abas Configurações, Agentes, Chats
admin.css              visual baseado no design system do CodeRise Hub
admin.js                lógica das 3 abas (fetch nas APIs abaixo)
api/
  webhook.js           endpoint que a SoftCS chama a cada evento de ticket
  settings.js           credenciais OAuth da SoftCS (tabela settings)
  agents.js              CRUD do mapeamento agente SoftCS -> @telegram
  chats.js                CRUD dos chats do Telegram
  oauth-start.js          passo 1 da autorização OAuth
  oauth-callback.js       passo 2 da autorização OAuth
lib/
  db.js                conexão com o Neon
  settings.js           leitura/escrita da tabela settings
  softcs.js              token OAuth (refresh automático) + chamadas à API SoftCS
  telegram.js             envio de mensagem via Bot API (um chat ou broadcast pra vários)
sql/
  schema.sql            tabelas: agent_mapping, softcs_oauth_tokens, processed_webhook_events,
                         telegram_chats, oauth_pkce_state, settings
dev-server.js          servidor local leve pra `npm run dev` (sem precisar de vercel CLI)
```
