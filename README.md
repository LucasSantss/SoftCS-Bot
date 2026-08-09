# SoftCS → Telegram

Recebe o payload do webhook de ticket da SoftCS (criação **e** atualização) e posta uma
mensagem em um ou mais chats do Telegram — com título, estágio do Kanban, link direto pro
ticket (`https://admin.softcs.com.br/pt-br/tickets/{publicId}`) e a menção (`@username`) de
quem criou o ticket. A mensagem só vai pro(s) chat(s) onde esse criador está cadastrado como
membro (aba Chats) — é o único jeito da `@menção` realmente notificar alguém no Telegram, já
que só funciona se a pessoa for membro do chat/grupo. Se o criador não estiver em nenhum chat
cadastrado, cai pra todos os chats ativos (sem mention funcional, só o nome). O caminho do
webhook em si (`api/webhook.js`) não usa a API autenticada da SoftCS — só recebe o POST e
monta a mensagem com o que vier nele. A API autenticada (OAuth2) é usada só pela aba
**Tickets**, pra consultar os tickets e ajudar a montar o mapeamento de agentes.

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
> webhook — só a tela de configuração dentro do painel mostra isso. `classifyEvent()`
> também é um chute: usa regex (`/creat/i` pra criação, `/updat|chang|mov/i` pra
> atualização) em cima de `event`/`type`, sem nunca ter visto o nome real desses eventos.
> Assim que você tiver um evento de teste real (o painel geralmente tem um botão "enviar
> teste"), ajuste `parsePayload()`/`classifyEvent()` em `api/webhook.js` para bater com os
> campos e nomes de evento reais.

## O que a API pública da SoftCS entrega (e o que não entrega)

Testado ao vivo com OAuth2 conectado, contra `/clients/{clientId}/tickets`:

- ✅ Título, prioridade, cliente (via `/clients`, que tem nome de verdade), `createdById`,
  `stageId` — tudo isso vem certo.
- ❌ **Nome/e-mail de quem criou o ticket** (`createdBy.name`/`email`) vêm `null` — a API
  pública só dá o ID. Não existe endpoint `/users` ou `/agents` pra resolver esse ID.
- ❌ **Nome da coluna do Kanban** (`stage.name`) também não vem — só `stageId`.

Também testei se `/clients/{clientId}/contacts` poderia resolver esses IDs — não resolve:
comparei os IDs de `agentId`/`createdById` de tickets reais com os IDs retornados por
`/contacts` do mesmo cliente e nenhum bate. `/contacts` são as pessoas do lado do
**cliente** (ex: "Maria Fernanda", contato da Toka Brasil); `agentId`/`createdById` são da
**equipe interna** da SoftCS — coleções diferentes, sem relação.

Ou seja: qualquer JSON que já tenha aparecido com nome/e-mail/hash de senha embutido veio
de um endpoint **interno** da SoftCS (sessão logada no navegador — a tela de "Usuários" em
Configurações), não da API pública. Pra contornar isso:

- **Nome da coluna**: clique no nome da coluna no Kanban (aba Tickets) pra renomear uma vez
  — fica salvo em `stage_labels` e usado dali em diante.
- **Nome/e-mail de quem criou**: cole o payload da tela "Usuários" da SoftCS (JSON, ou o
  texto cru copiado do DevTools) no card "Importar usuários da SoftCS" da aba Agentes —
  importa nome e e-mail de todo mundo de uma vez, indexado pelo ID. O `@` do Telegram
  continua manual (só existe na sua cabeça, não em nenhuma API), mas agora pelo menos você
  já vê o nome/e-mail de cada ID sem precisar caçar ticket por ticket.

## Painel: Tickets, Agentes, Chats

**Aba Tickets**: conecta a aplicação OAuth2 (Client ID/Secret/Redirect URI) e um único
botão, **"Buscar todos os tickets abertos"**, traz os tickets abertos (`closedAt` nulo) de
toda a conta, agrupados em colunas por `stageId` (igual ao Kanban da SoftCS). Clique no
nome da coluna pra renomear.

> Contas grandes têm milhares de clientes (testei numa conta real com mais de 2000) e a
> SoftCS só lista tickets por cliente — não existe um `/tickets` geral (retorna 404) nem um
> jeito de saber de antemão quais clientes têm ticket aberto. Pra não estourar o tempo da
> function numa chamada só, `api/discover-tickets.js` escaneia **um lote de 200 clientes
> por chamada**, e o próprio navegador (`admin.js`) encadeia as chamadas sozinho — sem
> precisar clicar de novo — até acabar ou você clicar em **Parar**. O board vai se
> preenchendo lote a lote; uma varredura completa (2000+ clientes) leva alguns minutos.

> A SoftCS também limita requisições por IP (visto ao vivo: 2000 requisições a cada 10
> minutos — o erro vem como `429 rate_limit_exceeded`, com `retryAfterSeconds`). Uma
> varredura completa de uma conta grande facilmente ultrapassa isso. Quando acontece, o
> painel pausa sozinho pelo tempo pedido (mostra a contagem regressiva no status) e retoma
> do mesmo lote — sem perder o progresso já feito.

**Aba Agentes**:
- **Importar usuários da SoftCS**: cola o payload da tela "Usuários" (Configurações >
  Usuários no painel da SoftCS) e importa nome + e-mail de todo mundo de uma vez
  (`api/import-agents.js`). Não mexe no `@` de quem já tinha um cadastrado.
- **Novo agente / preencher @**: cadastro manual — ID sempre obrigatório, `@`/nome/e-mail
  opcionais (dá pra usar só pra preencher o `@` de alguém que já foi importado).
- **Criadores encontrados**: lista deduplicada dos criadores vistos na última busca feita
  na aba Tickets — cada um mostra se já tem `@` cadastrado (badge verde) ou não (campo pra
  preencher), usando o nome/e-mail importados como fallback quando o próprio ticket não
  trouxer nome. O botão **Salvar todos preenchidos** salva de uma vez todo mundo que você
  já preencheu, sem precisar clicar linha por linha.

**Aba Chats**: chat_id de cada grupo/canal, com o botão **Testar** mandando uma mensagem
de teste na hora pra confirmar que o chat_id está certo e o bot ainda posta ali. Ao
cadastrar um chat novo (ou abrindo o painel **Membros** de um já existente), dá pra marcar
quais agentes fazem parte dele (multi-select, salvo em `chat_agents`) — quando um desses
agentes é o criador de um ticket que é criado ou atualizado, a notificação vai
especificamente pro(s) chat(s) onde ele é membro (é o que faz a `@menção` funcionar de
verdade: Telegram só notifica quem está no grupo). Sem nenhum membro cadastrado pra aquele
criador, a notificação cai pra todos os chats ativos.

> Pra o token nunca expirar sem renovar sozinho, a aplicação OAuth2 na SoftCS precisa ter
> o escopo `offline_access` habilitado (Identidade > "Continuar conectada mesmo após
> sair"). Sem isso, a conexão pede `offline_access` mas a SoftCS recusa com
> `invalid_scope`, e sem `offline_access` concedido o `access_token` dura ~1h sem
> `refresh_token` — nesse caso "Buscar tickets" avisa "token expirou" e é só clicar em
> **Conectar** de novo.

> Nota técnica: a API pagina como `{ data: [...], pagination: { hasMore, nextOffset } }`,
> não `{ items: [...] }` como a documentação sugere — `extractItems()` em
> `api/discover-tickets.js` lida com os dois formatos. `limit` máximo é 200; os tickets
> vêm ordenados por `sortBy=kanbanPosition` (o mesmo critério do board visual).

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
4. Clique em **Buscar todos os tickets abertos** — o board vai se preenchendo sozinho, lote
   a lote. Renomeie as colunas clicando nelas.

Na aba **Agentes**, preencha o `@` de cada criador que aparecer em "Criadores
encontrados" e clique em **Salvar todos preenchidos** (ou cadastre manualmente).

Na aba **Chats**, cadastre cada grupo/canal que deve receber as notificações. Descubra o
`chat_id` enviando uma mensagem no grupo (com o bot já adicionado) e acessando
`https://api.telegram.org/bot<TOKEN>/getUpdates` — o `chat.id` aparece no JSON
(grupos costumam ter id negativo). Use o botão **Testar** pra confirmar. Marque também
quais agentes são membros daquele chat (select múltiplo no formulário, ou no painel
**Membros** de um chat já cadastrado) — só assim a notificação de ticket vai parar
especificamente ali quando um desses agentes for o criador.

> **Importante sobre a menção `@username`**: o Telegram só notifica a pessoa se ela
> (a) tiver um `@username` público configurado e (b) for membro do chat/grupo onde o
> bot posta. Se a pessoa não estiver no grupo, o `@username` aparece como texto/link
> mas ninguém é notificado.

### 5. Cadastrar o webhook na SoftCS

No painel da SoftCS (tela de Webhooks), cadastre:

- URL: `https://SEU-DOMINIO.vercel.app/api/webhook`
- Eventos: criação **e** atualização de ticket (`classifyEvent()` em `api/webhook.js`
  tenta reconhecer os dois pelo nome do evento — ver pendência conhecida acima)

Dispare o evento de teste, se existir, e confira no log da Vercel (`vercel logs`)
o corpo recebido — ajuste `parsePayload()`/`classifyEvent()` em `api/webhook.js` conforme
o formato real.

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
  webhook.js            endpoint que a SoftCS chama a cada evento de ticket (criação e
                        atualização) — resolve @menção, nome do estágio e link do ticket,
                        e manda pro(s) chat(s) onde o criador é membro (chat_agents)
  agents.js              CRUD do mapeamento agente SoftCS -> @telegram
  chats.js                CRUD dos chats do Telegram + membros (chat_agents)
  settings.js              credenciais OAuth da SoftCS (tabela settings)
  oauth-start.js            passo 1 da conexão OAuth (botão "Conectar")
  oauth-callback.js          passo 2 da conexão OAuth
  discover-tickets.js         escaneia um lote de clientes (?offset=) e devolve os tickets
                              abertos deles + se há mais lote (hasMoreClients/nextOffset)
  stage-labels.js               nomes das colunas do Kanban (cadastrados manualmente)
  import-agents.js                importa nome/e-mail em lote (JSON ou stream RSC colado)
  telegram-test.js                  manda uma mensagem de teste pra um chat_id (botão "Testar")
lib/
  db.js                 conexão com o Neon
  agents.js              busca o @username cadastrado pro criador do ticket
  telegram.js             envio de mensagem via Bot API (um chat ou broadcast pra vários)
  settings.js              leitura/escrita da tabela settings
  softcs-api.js             token OAuth (refresh automático) + chamadas à API da SoftCS
                            (getClients, getClientTickets)
sql/
  schema.sql            tabelas: agent_mapping (softcs_user_id, telegram_username opcional,
                         display_name, email), processed_webhook_events, telegram_chats,
                         chat_agents (membros de cada chat), settings, softcs_oauth_tokens,
                         oauth_pkce_state, stage_labels
dev-server.js          servidor local leve pra `npm run dev` (sem precisar de vercel CLI)
```
