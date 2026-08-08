# SoftCS → Telegram

Recebe o payload do webhook de ticket da SoftCS e posta um resumo em um ou mais chats do
Telegram, mencionando quem criou o ticket (`@username`), usando um mapeamento manual entre
o ID de usuário da SoftCS e o `@username` no Telegram. Não usa a API autenticada da SoftCS
em nenhum momento — só recebe o POST do webhook e monta a mensagem com o que vier nele.

Só existem duas variáveis de ambiente: `DATABASE_URL` e `TELEGRAM_BOT_TOKEN`. O mapeamento
de agentes e os chats do Telegram são cadastrados depois do deploy em `/admin.html`, e
ficam salvos no Neon.

> ⚠️ **`/admin.html` não tem senha nenhuma** — foi uma escolha deliberada (uso pessoal, sem
> fricção de login). Qualquer pessoa com a URL consegue ver e editar os agentes e chats
> cadastrados. Não divulgue essa URL.

> ⚠️ **Pendência conhecida**: o parser em [api/webhook.js](api/webhook.js) foi escrito
> com um formato de payload provisório (`{ event, eventId, data: { title, priority,
> createdById, ... } }`), pois a documentação pública da SoftCS não descreve o corpo do
> webhook — só a tela de configuração dentro do painel mostra isso. Assim que você tiver
> um evento de teste real (o painel geralmente tem um botão "enviar teste"), ajuste
> `parsePayload()` em `api/webhook.js` para bater com os campos reais.

## Por que o mapeamento de agentes é manual

A API pública da SoftCS não tem um recurso `users`/`agents`, e o payload do ticket só traz
`createdById` (um ID opaco, sem nome/e-mail/username). Por isso o mapeamento é preenchido à
mão em `/admin.html`: identifique quem é o criador de cada ticket (olhando na SoftCS) e
cadastre o ID correspondente lá.

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

### 4. Cadastrar agentes e chats em /admin.html

Acesse `https://SEU-DOMINIO.vercel.app/admin.html`.

- Aba **Agentes**: ID do usuário na SoftCS → `@username` no Telegram.
- Aba **Chats**: cada grupo/canal que deve receber as notificações. Descubra o `chat_id`
  enviando uma mensagem no grupo (com o bot já adicionado) e acessando
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

Dispare o evento de teste, se existir, e confira no log da Vercel (`vercel logs`)
o corpo recebido — ajuste `parsePayload()` em `api/webhook.js` conforme o formato real.

## Rodando localmente

```bash
npm install
npm run dev        # sobe em http://localhost:3000, sem precisar de `vercel login`
```

Usa `node --env-file=.env`, então só precisa do `.env` com `DATABASE_URL` e
`TELEGRAM_BOT_TOKEN`.

## Estrutura

```
admin.html            painel único (sem login): abas Agentes e Chats
admin.css              visual baseado no design system do CodeRise Hub
admin.js                lógica das 2 abas (fetch nas APIs abaixo)
api/
  webhook.js           endpoint que a SoftCS chama a cada evento de ticket
  agents.js             CRUD do mapeamento agente SoftCS -> @telegram
  chats.js               CRUD dos chats do Telegram
lib/
  db.js                conexão com o Neon
  agents.js             busca o @username cadastrado pro criador do ticket
  telegram.js            envio de mensagem via Bot API (um chat ou broadcast pra vários)
sql/
  schema.sql           tabelas: agent_mapping, processed_webhook_events, telegram_chats
dev-server.js         servidor local leve pra `npm run dev` (sem precisar de vercel CLI)
```
