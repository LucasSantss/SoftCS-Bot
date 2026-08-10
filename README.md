# SoftCS → Telegram

Detecta ticket novo ou movido de coluna no Kanban da SoftCS e posta uma mensagem em um ou
mais chats do Telegram — com título, estágio, link direto pro ticket
(`https://admin.softcs.com.br/pt-br/tickets/{publicId}`) e a menção (`@username`) de quem
criou o ticket. A mensagem só vai pro(s) chat(s) onde esse criador está cadastrado como
membro (aba Chats) — é o único jeito da `@menção` realmente notificar alguém no Telegram, já
que só funciona se a pessoa for membro do chat/grupo. Se o criador não estiver em nenhum chat
cadastrado, cai pra todos os chats ativos (sem mention funcional, só o nome).

**A detecção é por polling, não por webhook.** Investigamos a fundo (self-service da SoftCS,
inclusive a aba Automações) e não existe webhook de ticket disponível na plataforma — ver
"Por que polling, não webhook" abaixo. Um workflow do GitHub Actions chama
`api/poll-tickets.js` a cada 15 minutos, que varre a conta inteira via API e compara com o
último estado conhecido de cada ticket (tabela `ticket_state`) pra descobrir o que mudou.
`api/webhook.js` continua existindo (não exige sessão — seria chamado pela SoftCS, não por
um navegador logado) pro caso de a SoftCS vir a liberar webhook de verdade no futuro, mas não
é o caminho usado hoje.

Só existem cinco variáveis de ambiente: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `CRON_SECRET`. Tudo o resto (credenciais OAuth2
da SoftCS, mapeamento de agentes, chats do Telegram, nomes das colunas do Kanban, lista de
e-mails com acesso ao painel) é cadastrado depois do deploy direto na URL do domínio
(`index.html`), e fica salvo no Neon.

**O painel exige login com Google, restrito a e-mails `@chatbotmaker.io` e só quem estiver
liberado.** `lucasrodrigues@chatbotmaker.io` é o master fixo (não pode ser removido, único
que vê a aba **Acesso**) e é quem decide, dali, quais outros e-mails `@chatbotmaker.io`
podem entrar — ver [lib/auth.js](lib/auth.js) e a seção de Setup abaixo. Sem sessão válida,
`/` redireciona pra `/login.html` (via [middleware.js](middleware.js) e, como reforço, o
próprio `admin.js` ao levar um 401 de qualquer chamada); a validação de verdade — sessão
existe no banco e o e-mail continua na allowlist — acontece em cada endpoint de `/api/*`
(exceto `/api/webhook`, chamado pela SoftCS, não por um navegador logado).

> ⚠️ **`api/webhook.js` é código morto por enquanto.** O parser foi escrito com um formato
> de payload provisório, já que nunca vimos um evento real — porque, até onde investigamos,
> não existe webhook de ticket no self-service da SoftCS (ver seção abaixo). Se algum dia a
> SoftCS liberar isso (ex: sob pedido ao suporte), ajuste `parsePayload()`/`classifyEvent()`
> nesse arquivo pra bater com o formato real. Enquanto isso, quem detecta ticket
> novo/movido é o polling — ver "Por que polling, não webhook" e "Detecção via polling"
> abaixo.

## Por que polling, não webhook

A ideia original era a SoftCS chamar um webhook nosso a cada ticket criado/atualizado.
Não achamos isso em lugar nenhum do self-service:

- Não existe uma tela dedicada "Webhooks" nas Configurações.
- A aba **Integrações** deixa configurar uma chamada HTTP de saída (URL, método, auth) —
  parecia promissor — mas ela só serve como **ação de uma Automação**, e a aba
  **Automações** só dispara pra mudanças em **Clientes** (Alvo da Automação = Clientes,
  filtros são "Campos do Cliente"), com ações fixas (Criar tarefa, Atualizar campo do
  cliente, Alterar jornada, E-mail, WhatsApp) — nenhuma delas é "chamar uma URL/Integração"
  nem existe gatilho de ticket. Confirmado direto na tela, não é suposição.

Ou seja: sem um caminho de webhook real, e sem endpoint de "listar todos os tickets" (só
`/clients/{clientId}/tickets`, por cliente), a única forma de saber o que mudou é varrer a
conta periodicamente e comparar com o que já sabíamos — daí o `api/poll-tickets.js` +
`ticket_state`. Se a SoftCS vier a liberar webhook de verdade (vale perguntar pro suporte),
a arquitetura de mensagem/roteamento (`lib/ticket-notify.js`) já é compartilhada entre
`api/webhook.js` e `api/poll-tickets.js` — bastaria reativar o primeiro.

## Detecção via polling

`api/poll-tickets.js` é chamado por um workflow do GitHub Actions
([.github/workflows/poll-tickets.yml](.github/workflows/poll-tickets.yml)) a cada 15
minutos, autenticado por um header `Authorization: Bearer <CRON_SECRET>` (mesmo valor
cadastrado como env var na Vercel e como secret `CRON_SECRET` no repositório do GitHub — ver
Setup). Não roda como Cron Job da própria Vercel porque **o plano Hobby limita cron a 1x por
dia** — inviável pra isso. Duas fases, nessa ordem, como dois steps separados no workflow:

**1) `?phase=known`** — reconfirma só os clientes donos de tickets que **já estão** em
`ticket_state` (uma chamada só, sem paginação, já que são poucos clientes — um por ticket já
conhecido, não a conta inteira). Roda primeiro e sempre completa, então a movimentação de
tickets já conhecidos é detectada de forma confiável todo ciclo de 15min, mesmo que a fase 2
não termine a tempo do token expirar.

**2) Descoberta (padrão, sem `phase`)** — escaneia **um lote de clientes** (mesmo padrão de
`api/discover-tickets.js`, via `lib/ticket-scan.js`, compartilhado entre os dois) pra achar
tickets novos em clientes ainda não vistos; o workflow encadeia as chamadas em loop (bash +
`jq`) até `hasMoreClients` virar `false`, com o mesmo backoff de rate limit
(`retryAfterSeconds`) que o painel já usava. **O offset não é passado pelo workflow** — o
servidor guarda sozinho onde parou (`ticket_poll_cursor` na tabela `settings`) e cada chamada
nova continua dali, mesmo que seja de uma execução diferente do GitHub Actions. Isso importa
porque, sem `refresh_token` (ver aviso abaixo), o `access_token` pode expirar no meio de uma
varredura de conta grande — sem esse cursor persistido, cada ciclo de 15min recomeçaria do
zero e nunca chegaria nos clientes "do fim da fila", deixando tickets novos neles pra sempre
não-descobertos (a fase 1 não ajuda aqui, já que só sabe de tickets que já foram descobertos
antes). Com o cursor, o progresso acumula entre execuções (mesmo as que falham no meio) até
completar uma volta inteira pela conta, e então reinicia do zero pro próximo ciclo.
`?offset=` na query ainda funciona como override manual pra debug.

As duas fases usam a mesma lógica de comparação (`processTicket()` em `api/poll-tickets.js`):
cada ticket aberto encontrado é comparado com a tabela `ticket_state`:

- **Sem linha anterior** → ticket novo → notifica "criado" e grava o estado.
- **`stage_id` diferente do salvo** → ticket mudou de coluna → notifica "atualizado" e
  atualiza o estado.
- **`stage_id` igual** → nada acontece.

**Limitações conhecidas dessa abordagem** (documentadas, não bugs):
- Só detecta **criação** e **mudança de estágio** — outros campos (título, prioridade
  etc.) mudarem sozinhos não dispara nada. Foi o que foi pedido ("movimentações dos
  tickets").
- Ticket fechado simplesmente some das varreduras (só listamos abertos); a linha em
  `ticket_state` fica órfã. Se reabrir depois **no mesmo estágio**, a mudança não é
  detectada (caso raro, não vale a complexidade extra agora).
- **Atraso de até ~15 minutos** entre a mudança acontecer na SoftCS e a mensagem chegar no
  Telegram — não é tempo real como um webhook seria.
- **Modo seed**: na primeiríssima varredura depois de configurado, `ticket_state` está
  vazio — sem tratamento especial, TODOS os tickets abertos da conta disparariam "criado"
  de uma vez, inundando os chats. Enquanto a flag `ticket_poll_seeded` (tabela `settings`)
  não estiver marcada, a varredura só grava o estado, sem notificar; a flag é marcada
  sozinha quando a primeira varredura completa termina. Dali em diante funciona normal.
- Uma varredura completa da conta consome perto do limite de rate da SoftCS (2000
  req/10min) sozinha numa conta grande — 429 esporádico durante o polling é esperado e
  tratado (retry com o `retryAfterSeconds` pedido), não é erro fatal.

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

- **Nome e ordem da coluna**: clique no nome da coluna no Kanban (aba Tickets) — pede o
  nome e depois a posição (número; quanto menor, mais à esquerda) e salva os dois em
  `stage_labels`, usado dali em diante tanto no nosso Kanban quanto no nome do estágio que
  vai na mensagem do Telegram. Sem posição definida, a coluna cai no fim. É a única forma de
  fazer nosso board bater com o Kanban real da SoftCS (nome **e** ordem), já que a API
  pública não devolve nenhum dos dois — confirmado ao vivo, o ticket cru só tem `stageId`,
  sem nome nem posição embutidos.
- **Nome/e-mail de quem criou**: cole o payload da tela "Usuários" da SoftCS (JSON, ou o
  texto cru copiado do DevTools) no card "Importar usuários da SoftCS" da aba Agentes —
  importa nome e e-mail de todo mundo de uma vez, indexado pelo ID. O `@` do Telegram
  continua manual (só existe na sua cabeça, não em nenhuma API), mas agora pelo menos você
  já vê o nome/e-mail de cada ID sem precisar caçar ticket por ticket.

## Painel: Tickets, Agentes, Chats, Acesso

**Aba Tickets**: conecta a aplicação OAuth2 (Client ID/Secret/Redirect URI). O Kanban
**carrega sozinho ao abrir a página**, lendo o snapshot salvo em `ticket_state` (a mesma
tabela mantida pelo polling a cada 15min — ver "Detecção via polling") via
`GET /api/discover-tickets?source=stored`, sem chamar a SoftCS nem gastar rate limit — por
isso sobrevive a reload e só muda quando o polling realmente detectar algo diferente, não a
cada vez que a página é aberta. O botão **"Buscar todos os tickets abertos"** continua
disponível pra fazer uma varredura **ao vivo** contra a SoftCS agora mesmo (sem esperar o
próximo ciclo de 15min) — útil pra conferir se algum ticket está na coluna errada e
descobrir se é erro do nosso lado ou coisa que ainda não chegou no snapshot salvo. Pra bater
exatamente com o Kanban real da SoftCS (mesmo nome, mesma ordem das colunas), clique em cada
nome de coluna e defina nome + posição (ver seção acima) — vale tanto pro board salvo quanto
pro ao vivo, já que os dois usam a mesma tabela `stage_labels`.

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

> ⚠️ **Pendência séria em aberto**: mesmo com o escopo `offline_access` habilitado
> (Identidade > "Continuar conectada mesmo após sair") e reconectado várias vezes, a SoftCS
> nunca devolveu um `refresh_token` até agora — só `access_token`, que dura ~1h. Isso afeta
> o polling de verdade: sem reconectar manualmente a cada ~1h, `api/poll-tickets.js` fica
> incapaz de escanear (confirmado ao vivo: 11h+ sem nenhuma atualização em `ticket_state`
> por falta de reconexão), então nenhuma notificação sai nesse período. `api/discover-tickets.js`
> e `api/poll-tickets.js` tentam renovar o token duas vezes por chamada (início e fim) só
> por garantia, mas isso não ajuda em nada sem um `refresh_token` pra renovar. Se isso não
> se resolver sozinho, vale abrir chamado com o suporte da SoftCS perguntando especificamente
> por que a resposta do token nunca inclui `refresh_token` mesmo com `offline_access`
> concedido — pode ser bug da plataforma ou alguma habilitação adicional do lado deles.
> Enquanto isso, "Buscar tickets" avisa "token expirou" quando isso acontece, e é só clicar
> em **Conectar** de novo.

> Nota técnica: a API pagina como `{ data: [...], pagination: { hasMore, nextOffset } }`,
> não `{ items: [...] }` como a documentação sugere — `extractItems()` em
> `api/discover-tickets.js` lida com os dois formatos. `limit` máximo é 200; os tickets
> vêm ordenados por `sortBy=kanbanPosition` (o mesmo critério do board visual).

> `getClients()` em [lib/softcs-api.js](lib/softcs-api.js) filtra `status=ACTIVE` (testado
> ao vivo — a API honra esse filtro de verdade, server-side, não só devolve o campo pra
> filtrar depois). Clientes inativos/churned nunca abrem ticket novo, então excluí-los do
> escaneamento (tanto aqui quanto no polling) reduz bastante o número de clientes
> verificados a cada varredura — menos chamadas, mais rápido, mais longe do rate limit.
> Efeito colateral: um ticket aberto que pertença a um cliente que virou inativo some das
> varreduras (Kanban e polling) do mesmo jeito que sumiria se fosse fechado — não é tratado
> como caso especial.

**Aba Acesso** (só aparece pra `lucasrodrigues@chatbotmaker.io`, o master): lista de
e-mails `@chatbotmaker.io` liberados a entrar no painel (`allowed_users`), com botão pra
liberar um novo e remover quem já tinha acesso. Remover um e-mail também derruba na hora
qualquer sessão ativa dele (`sessions`), não só bloqueia logins futuros.

## Setup

### 1. Banco (Neon)

Crie um projeto em [neon.tech](https://neon.tech), pegue a connection string e rode
o conteúdo de [sql/schema.sql](sql/schema.sql) (SQL Editor do Neon ou `psql`).

### 2. Variáveis de ambiente

Só estas cinco, tanto no `.env` local quanto no painel do projeto na Vercel:

- `DATABASE_URL` — connection string do Neon
- `TELEGRAM_BOT_TOKEN` — token do bot, criado com [@BotFather](https://t.me/BotFather)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — credenciais OAuth2 do Google pro login do
  painel (ver passo 4)
- `CRON_SECRET` — segredo que autentica as chamadas do GitHub Actions em
  `/api/poll-tickets` (ver passo 6). Gere um valor aleatório com:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

### 3. Deploy

```bash
npm install
npx vercel        # ou: conectar o repo pela dashboard da Vercel
```

### 4. Login com Google (obrigatório antes de usar o painel)

1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), crie uma
   credencial OAuth2 do tipo "Aplicativo da Web".
2. Em "Origens JavaScript autorizadas", adicione `https://SEU-DOMINIO.vercel.app`.
3. Em "URIs de redirecionamento autorizados", adicione
   `https://SEU-DOMINIO.vercel.app/api/auth-callback`.
4. Copie o Client ID e o Client Secret gerados e cadastre como `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` nas variáveis de ambiente da Vercel (e faça um redeploy, já que
   são variáveis de ambiente — mudam só no próximo build/deploy).

`lucasrodrigues@chatbotmaker.io` já entra liberado (linha seedada em
[sql/schema.sql](sql/schema.sql), e o `MASTER_EMAIL` em `lib/auth.js` também garante isso
mesmo que a linha suma do banco). Pra liberar qualquer outro e-mail `@chatbotmaker.io`,
entre com essa conta master e cadastre na aba **Acesso** — só aparece pra ela.

### 5. Conectar a SoftCS e cadastrar agentes/chats

Acesse `https://SEU-DOMINIO.vercel.app/` e entre com uma conta Google `@chatbotmaker.io`
liberada — o painel é a própria raiz do domínio (`index.html`), não precisa de nenhum
caminho extra.

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

### 6. Ligar o polling (GitHub Actions)

Sem webhook disponível na SoftCS (ver "Por que polling, não webhook" acima), quem detecta
ticket novo/movido é o workflow [.github/workflows/poll-tickets.yml](.github/workflows/poll-tickets.yml),
rodando a cada 15 minutos.

1. No repositório do GitHub, vá em **Settings > Secrets and variables > Actions** e crie um
   secret chamado `CRON_SECRET` com o **mesmo valor** que você colocou na env var
   `CRON_SECRET` da Vercel (passo 2).
2. Confirme que o workflow está na branch padrão do repositório — `schedule` só dispara pra
   workflows presentes ali (aqui, a branch padrão já é a que você usa pra tudo).
3. As Actions precisam estar habilitadas no repositório (**Settings > Actions > General** —
   normalmente já vêm habilitadas por padrão).
4. Pra não esperar até 15 minutos pra testar, dispare manualmente: aba **Actions** do
   GitHub > **Poll SoftCS tickets** > **Run workflow**.

Na primeira execução depois de configurado, o polling entra em **modo seed** automaticamente
(grava o estado de todos os tickets abertos sem notificar ninguém — senão inundaria os
chats) e só passa a notificar normalmente a partir da segunda varredura completa. Isso é
esperado, não é bug.

## Rodando localmente

```bash
npm install
npm run dev        # sobe em http://localhost:3000, sem precisar de `vercel login`
```

Usa `node --env-file=.env`, então só precisa do `.env` com `DATABASE_URL`,
`TELEGRAM_BOT_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `CRON_SECRET`. Pra testar
o login localmente, adicione `http://localhost:3000` nas origens autorizadas e
`http://localhost:3000/api/auth-callback` nos redirect URIs da credencial OAuth2 do Google
(dá pra usar a mesma credencial de produção, só adicionando essas duas entradas a mais).
Pra testar a conexão OAuth2 da SoftCS localmente, cadastre
`http://localhost:3000/api/oauth-callback` como Redirect URI tanto no painel quanto na
aplicação OAuth2 da SoftCS. Pra testar o polling manualmente:
`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/poll-tickets`.

## Estrutura

```
index.html             painel (exige login), servido na raiz do domínio: abas Tickets,
                       Agentes, Chats, Acesso (só master)
login.html               tela de login ("Entrar com Google"), mostra erro de domínio/allowlist
middleware.js             Edge Middleware: sem cookie de sessão, redireciona / pro login
admin.css               visual baseado no design system do CodeRise Hub
admin.js                 lógica das abas (fetch nas APIs abaixo); redireciona pro login em 401
.github/workflows/
  poll-tickets.yml     roda api/poll-tickets.js a cada 15min: primeiro ?phase=known (reconfirma
                       tickets já conhecidos), depois a descoberta em loop de lotes (bash + jq)
                       com backoff se a SoftCS responder 429 — ver "Detecção via polling"
api/
  webhook.js            código morto por enquanto: endpoint que a SoftCS chamaria a cada
                        evento de ticket, mas não há webhook disponível na plataforma (ver
                        "Por que polling, não webhook"). Não exige sessão — seria chamado
                        pela SoftCS, não por um navegador logado.
  poll-tickets.js         chamado pelo workflow do GitHub Actions, duas fases: ?phase=known
                          reconfirma só os clientes de tickets já em ticket_state (rápido,
                          sempre completo); padrão descobre tickets novos varrendo a conta em
                          lotes (mesmo padrão do discover-tickets.js), retomando de
                          ticket_poll_cursor. As duas usam processTicket() pra comparar com
                          ticket_state e notificar criação/mudança de estágio. Autenticado por
                          CRON_SECRET (header Authorization: Bearer), não por sessão.
  auth.js                 login: start (redireciona pro Google), callback (troca code por
                          token, checa domínio + allowlist, cria sessão), logout, me (quem
                          está logado) e users (CRUD da allowlist, só master) — um arquivo
                          só cobrindo /api/auth-start, /api/auth-callback, /api/auth-logout,
                          /api/me e /api/users via rewrite (ver vercel.json e nota abaixo)
  agents.js              CRUD do mapeamento agente SoftCS -> @telegram
  chats.js                CRUD dos chats do Telegram + membros (chat_agents)
  settings.js              credenciais OAuth da SoftCS (tabela settings)
  softcs-oauth.js            conexão OAuth2 da SoftCS: start (botão "Conectar") e callback —
                            um arquivo só cobrindo /api/oauth-start e /api/oauth-callback
                            via rewrite, mesma razão do auth.js
  discover-tickets.js         dois modos: padrão escaneia um lote de clientes ao vivo
                              (?offset=) e devolve os tickets abertos deles (botão "Buscar
                              tickets"); ?source=stored lê o snapshot de ticket_state (o que
                              o painel carrega sozinho ao abrir a página)
  stage-labels.js               nomes das colunas do Kanban (cadastrados manualmente)
  import-agents.js                importa nome/e-mail em lote (JSON ou stream RSC colado)
  telegram-test.js                  manda uma mensagem de teste pra um chat_id (botão "Testar")
vercel.json            reescreve /api/auth-start, /api/auth-callback, /api/auth-logout,
                       /api/me, /api/users, /api/oauth-start e /api/oauth-callback pros
                       arquivos consolidados acima (com ?action=...) — as URLs externas não
                       mudam, só a implementação por trás. Existe porque o plano Hobby da
                       Vercel limita a 12 Serverless Functions por deployment, e um arquivo
                       por rota estourava isso (chegou a 15; hoje são 11).
lib/
  db.js                 conexão com o Neon
  auth.js                 sessão/cookie, checagem de domínio @chatbotmaker.io + allowlist,
                          requireSession/requireMaster usados por quase todo /api/*
  ticket-scan.js           helpers de varredura em lote (extractItems, extractStage,
                          mapWithConcurrency etc.), compartilhados por discover-tickets.js
                          e poll-tickets.js
  ticket-notify.js          resolve @menção + nome do estágio + chat(s) alvo e manda a
                            mensagem no Telegram (notifyTicketEvent) — compartilhado por
                            webhook.js e poll-tickets.js
  agents.js              busca o @username cadastrado pro criador do ticket
  telegram.js             envio de mensagem via Bot API (um chat ou broadcast pra vários)
  settings.js              leitura/escrita da tabela settings
  softcs-api.js             token OAuth (refresh automático) + chamadas à API da SoftCS
                            (getClients, getClientTickets)
sql/
  schema.sql            tabelas: agent_mapping (softcs_user_id, telegram_username opcional,
                         display_name, email), processed_webhook_events, telegram_chats,
                         chat_agents (membros de cada chat), settings, softcs_oauth_tokens,
                         oauth_pkce_state, stage_labels (nome + posição de cada coluna do
                         Kanban), allowed_users (allowlist de login),
                         sessions (login do painel), google_oauth_state, ticket_state
                         (snapshot de cada ticket aberto — estágio, título, prioridade,
                         cliente e client_id — usado pelo polling pra notificar E pelo
                         painel pra mostrar o Kanban salvo sem precisar de uma varredura ao
                         vivo; client_id também alimenta a fase ?phase=known do polling)
dev-server.js          servidor local leve pra `npm run dev` (sem precisar de vercel CLI)
```
