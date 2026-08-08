# SoftCS → Telegram

Recebe o payload do webhook de ticket da SoftCS e posta um resumo em um ou mais chats do
Telegram, mencionando quem criou o ticket (`@username`), usando um mapeamento manual entre
o ID de usuário da SoftCS e o `@username` no Telegram. O caminho do webhook em si
(`api/webhook.js`) não usa a API autenticada da SoftCS — só recebe o POST e monta a
mensagem com o que vier nele. A API autenticada (OAuth2) é usada só pela aba **Tickets**,
pra consultar os tickets e ajudar a montar esse mapeamento.

Só existem duas variáveis de ambiente: `DATABASE_URL` e `TELEGRAM_BOT_TOKEN`. Tudo o resto
(credenciais OAuth2 da SoftCS, mapeamento de agentes, chats do Telegram, nomes das colunas
do Kanban) é cadastrado depois do deploy direto na URL do domínio (`index.html`), e fica
salvo no Neon.

> ⚠️ **O painel não tem senha nenhuma** — foi uma escolha deliberada (uso pessoal, sem
> fricção de login). Qualquer pessoa com a URL do domínio consegue ver e editar tudo,
> incluindo o `client_secret` da SoftCS. Não divulgue essa URL.

> ⚠️ **Pendência conhecida**: o parser em [api/webhook.js](api/webhook.js) foi escrito
> com um formato de payload provisório (`{ event, eventId, data: { title, priority,
> createdById, ... } }`), pois a documentação pública da SoftCS não descreve o corpo do
> webhook — só a tela de configuração dentro do painel mostra isso. Assim que você tiver
> um evento de teste real (o painel geralmente tem um botão "enviar teste"), ajuste
> `parsePayload()` em `api/webhook.js` para bater com os campos reais.

## O que a API pública da SoftCS entrega (e o que não entrega)

Testado ao vivo com OAuth2 conectado, contra `/clients/{clientId}/tickets`:

- ✅ Título, prioridade, cliente (via `/clients`, que tem nome de verdade), `createdById`,
  `stageId` — tudo isso vem certo.
- ❌ **Nome/e-mail de quem criou o ticket** (`createdBy.name`/`email`) vêm `null` — a API
  pública só dá o ID. Não existe endpoint `/users` ou `/agents` pra resolver esse ID.
- ❌ **Nome da coluna do Kanban** (`stage.name`) também não vem — só `stageId`.

Ou seja: qualquer JSON que já tenha aparecido com nome/e-mail/hash de senha embutido veio
de um endpoint **interno** da SoftCS (sessão logada no navegador), não desse OAuth público.
Pra contornar isso sem depender de endpoint não-oficial:

- **Nome da coluna**: clique no nome da coluna no Kanban (aba Tickets) pra renomear uma vez
  — fica salvo em `stage_labels` e usado dali em diante.
- **Nome de quem criou**: não tem solução automática. O jeito é abrir o mesmo ticket (pelo
  título, que aparece nos dois lugares) no Kanban de verdade da SoftCS, ver o nome ali, e
  digitar o `@` correspondente na aba Agentes — só precisa fazer isso uma vez por pessoa.

## Painel: Tickets, Agentes, Chats

**Aba Tickets**: conecta a aplicação OAuth2 (Client ID/Secret/Redirect URI) e mostra os
tickets em colunas, uma por `stageId` (igual ao Kanban da SoftCS). Clique no nome da coluna
pra renomear.

**Aba Agentes**:
- **Novo agente**: cadastro manual (ID + `@` + nome opcional).
- **Criadores encontrados**: lista deduplicada dos criadores vistos na última busca feita
  na aba Tickets — cada um mostra se já tem `@` cadastrado (badge verde) ou não (campo pra
  preencher). O botão **Salvar todos preenchidos** salva de uma vez todo mundo que você
  já preencheu, sem precisar clicar linha por linha.

**Aba Chats**: chat_id de cada grupo/canal, com o botão **Testar** mandando uma mensagem
de teste na hora pra confirmar que o chat_id está certo e o bot ainda posta ali.

> Pra o token nunca expirar sem renovar sozinho, a aplicação OAuth2 na SoftCS precisa ter
> o escopo `offline_access` habilitado (Identidade > "Continuar conectada mesmo após
> sair"). Sem isso, a conexão pede `offline_access` mas a SoftCS recusa com
> `invalid_scope`, e sem `offline_access` concedido o `access_token` dura ~1h sem
> `refresh_token` — nesse caso "Buscar tickets" avisa "token expirou" e é só clicar em
> **Conectar** de novo.

> Nota técnica: a API pagina como `{ data: [...], pagination: { hasMore, nextOffset } }`,
> não `{ items: [...] }` como a documentação sugere — `extractItems()` em
> `api/discover-tickets.js` lida com os dois formatos. `limit` máximo é 200 (tanto pra
> clientes quanto pra tickets); a busca pagina até 1000 clientes (5 páginas) e usa até 20
> requisições em paralelo.

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

### 4. Conectar a SoftCS e cadastrar agentes/chats

Acesse `https://SEU-DOMINIO.vercel.app/` — o painel é a própria raiz do domínio
(`index.html`), não precisa de nenhum caminho extra.

Na aba **Tickets**:

1. Crie uma aplicação OAuth2 em Configurações > Aplicações no painel da SoftCS, com
   redirect URI `https://SEU-DOMINIO.vercel.app/api/oauth-callback`, e habilite os escopos
   `tickets:read`, `clients:read` e `offline_access` (categoria Identidade).
2. Preencha Client ID, Client Secret e Redirect URI no painel e clique em **Salvar**.
3. Clique em **Conectar** — conclui o fluxo OAuth2 (Authorization Code + PKCE) e salva o
   token no Neon.
4. Clique em **Buscar tickets** — mostra o Kanban. Renomeie as colunas clicando nelas.

Na aba **Agentes**, preencha o `@` de cada criador que aparecer em "Criadores
encontrados" e clique em **Salvar todos preenchidos** (ou cadastre manualmente).

Na aba **Chats**, cadastre cada grupo/canal que deve receber as notificações. Descubra o
`chat_id` enviando uma mensagem no grupo (com o bot já adicionado) e acessando
`https://api.telegram.org/bot<TOKEN>/getUpdates` — o `chat.id` aparece no JSON
(grupos costumam ter id negativo). Use o botão **Testar** pra confirmar.

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
`TELEGRAM_BOT_TOKEN`. Pra testar a conexão OAuth2 localmente, cadastre
`http://localhost:3000/api/oauth-callback` como Redirect URI tanto no painel quanto na
aplicação OAuth2 da SoftCS.

## Estrutura

```
index.html             painel único (sem login), servido na raiz do domínio: abas Tickets, Agentes, Chats
admin.css               visual baseado no design system do CodeRise Hub
admin.js                 lógica das abas (fetch nas APIs abaixo)
api/
  webhook.js            endpoint que a SoftCS chama a cada evento de ticket
  agents.js              CRUD do mapeamento agente SoftCS -> @telegram
  chats.js                CRUD dos chats do Telegram
  settings.js              credenciais OAuth da SoftCS (tabela settings)
  oauth-start.js            passo 1 da conexão OAuth (botão "Conectar")
  oauth-callback.js          passo 2 da conexão OAuth
  discover-tickets.js         busca os tickets na SoftCS, agrupa por estágio e dedupe criadores
  stage-labels.js               nomes das colunas do Kanban (cadastrados manualmente)
  telegram-test.js                manda uma mensagem de teste pra um chat_id (botão "Testar")
lib/
  db.js                 conexão com o Neon
  agents.js              busca o @username cadastrado pro criador do ticket
  telegram.js             envio de mensagem via Bot API (um chat ou broadcast pra vários)
  settings.js              leitura/escrita da tabela settings
  softcs-api.js             token OAuth (refresh automático) + chamadas à API da SoftCS
sql/
  schema.sql            tabelas: agent_mapping, processed_webhook_events, telegram_chats,
                         settings, softcs_oauth_tokens, oauth_pkce_state, stage_labels
dev-server.js          servidor local leve pra `npm run dev` (sem precisar de vercel CLI)
```
