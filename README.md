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
"Por que polling, não webhook" abaixo. Um cron externo ([cron-job.org](https://cron-job.org))
chama `api/poll-tickets.js` periodicamente, que varre a conta via API e compara com o último
estado conhecido de cada ticket (tabela `ticket_state`) pra descobrir o que mudou.
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

`api/poll-tickets.js` é chamado periodicamente por um cron externo
([cron-job.org](https://cron-job.org), gratuito), autenticado por um header
`Authorization: Bearer <CRON_SECRET>` (mesmo valor cadastrado como env var na Vercel — ver
Setup). Não roda como Cron Job da própria Vercel porque **o plano Hobby limita cron a 1x por
dia** — inviável pra isso.

> ⚠️ **Por que não é o `schedule:` do GitHub Actions**: essa era a ideia original —
> [.github/workflows/poll-known.yml](.github/workflows/poll-known.yml) e
> [poll-tickets.yml](.github/workflows/poll-tickets.yml) tinham `on: schedule` configurado
> pra 5min/15min. Medido ao vivo por 2 dias inteiros: o intervalo real entre execuções ficou
> em **~55-70min de média** (chegando a 150min), **igual pros dois workflows independente do
> valor configurado** — ou seja, não é o nosso cron sendo respeitado com atraso, é um
> throttling do agendador do GitHub pra workflows agendados que ignora praticamente o
> intervalo pedido. Isso é bem mais severo do que o aviso oficial do GitHub Actions
> ("execuções agendadas podem atrasar em períodos de carga alta") sugere. Pra um bot cujo
> objetivo é avisar sobre ticket novo rapidamente, um gap de ~1h é inviável — por isso os dois
> workflows tiveram o `schedule:` removido (só ficou `workflow_dispatch`, usado pro disparo
> imediato ao reconectar — ver 6.1) e o cron externo assumiu o papel de disparar de verdade no
> intervalo configurado.

**1) `?phase=known`, a cada 2min** — reconfirma só os clientes donos de tickets que **já
estão** em `ticket_state` (uma chamada só, sem paginação, já que são poucos clientes — um por
ticket já conhecido, não a conta inteira). Roda separado da descoberta, então a movimentação
de tickets já conhecidos é detectada de forma confiável a cada 2min, mesmo que a descoberta
abaixo não termine a tempo do token expirar.

**2) Descoberta (padrão, sem `phase`), a cada 10min** — escaneia **um lote de clientes** por
chamada (mesmo padrão de `api/discover-tickets.js`, via `lib/ticket-scan.js`, compartilhado
entre os dois) pra achar tickets novos em clientes ainda não vistos. Ao contrário da fase 1,
uma chamada só não dá conta da conta inteira (pode ter milhares de clientes) — o cron externo
só dispara a chamada, sem saber de `hasMoreClients`; **o servidor guarda sozinho onde parou**
(`ticket_poll_cursor` na tabela `settings`) e cada chamada nova (a cada 10min) continua dali,
avançando um lote por vez até completar uma volta inteira pela conta, e então reinicia do zero
pro próximo ciclo. Isso importa porque, mesmo sem depender mais de token expirando no meio
(agora que `refresh_token` funciona — ver seção OAuth), uma conta grande ainda leva vários
ciclos de 10min pra escanear por completo; sem esse cursor persistido, cada chamada
recomeçaria do zero e nunca chegaria nos clientes "do fim da fila". `?offset=` na query ainda
funciona como override manual pra debug. (Os intervalos exatos — 2min/10min — são
configurados no próprio cron-job.org, não no código; ajustável a qualquer momento por lá sem
precisar de deploy.)

As duas fases usam a mesma lógica de comparação (`processTicket()` em `lib/ticket-notify.js`,
compartilhado também com `api/discover-tickets.js` — ver seção do Painel): cada ticket
aberto encontrado é comparado com a tabela `ticket_state`:

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
- **Atraso de até ~10 minutos** (2min pra tickets já conhecidos) entre a mudança acontecer na
  SoftCS e a mensagem chegar no Telegram — não é tempo real como um webhook seria.
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
  pública não devolve nenhum dos dois — confirmado ao vivo, `denormalizedStage`/`stage` vêm
  sempre `undefined` nela (só o endpoint interno de sessão do navegador tem isso, fora do
  nosso alcance; se algum payload colado aqui tiver esses campos preenchidos junto com
  senha/permissão de usuário, veio de lá, não da API que a gente usa).
- **Nome/e-mail de quem criou**: cole o payload da tela "Usuários" da SoftCS (JSON, ou o
  texto cru copiado do DevTools) no card "Importar usuários da SoftCS" da aba Agentes —
  importa nome e e-mail de todo mundo de uma vez, indexado pelo ID. O `@` do Telegram
  continua manual (só existe na sua cabeça, não em nenhuma API), mas agora pelo menos você
  já vê o nome/e-mail de cada ID sem precisar caçar ticket por ticket.

## Painel: Tickets, Agentes, Chats, Acesso

**Aba Tickets**: conecta a aplicação OAuth2 (Client ID/Secret/Redirect URI). O Kanban
**carrega sozinho ao abrir a página**, lendo o snapshot salvo em `ticket_state` (a mesma
tabela mantida pelo polling — ver "Detecção via polling") via
`GET /api/discover-tickets?source=stored`, sem chamar a SoftCS nem gastar rate limit — por
isso sobrevive a reload e só muda quando o polling realmente detectar algo diferente, não a
cada vez que a página é aberta. O botão **"Buscar todos os tickets abertos"** continua
disponível pra fazer uma varredura **ao vivo** contra a SoftCS agora mesmo (sem esperar o
próximo ciclo do cron) — útil pra conferir se algum ticket está na coluna errada e
descobrir se é erro do nosso lado ou coisa que ainda não chegou no snapshot salvo. Assim como
o polling (ver "Detecção via polling"), essa busca ao vivo também reconfirma primeiro os
clientes donos de tickets que já estão em `ticket_state` (`?phase=known`, rápido) antes de
seguir descobrindo o resto da conta em lotes — o botão manual usa a mesma prioridade que o
polling automático, não só a ordem que a SoftCS devolve.

**A busca manual também grava e notifica, exatamente como o polling automático** — não é só
um preview. As duas fases (`?phase=known` e a descoberta padrão) chamam o mesmo
`processTicket()` de `lib/ticket-notify.js` que o polling usa: comparam com `ticket_state` e
disparam a notificação no Telegram se algo mudou, antes de devolver os dados pro Kanban.
Isso importa na prática porque clicar em "Buscar todos os tickets abertos" manualmente também
conta como uma varredura de verdade e pode detectar e notificar mudanças que o ciclo do cron
ainda não pegou. Pra bater exatamente com o Kanban real da SoftCS (mesmo nome, mesma ordem
das colunas), clique em cada nome de coluna e defina nome + posição (ver seção acima) — vale
tanto pro board salvo quanto pro ao vivo, já que os dois usam a mesma tabela `stage_labels`.

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

> ✅ **Resolvido — `refresh_token` funciona, mas não do jeito que a documentação da SoftCS
> descreve.** Por muito tempo o `access_token` (dura 15min — `expires_in: 900`) nunca vinha
> acompanhado de `refresh_token`, mesmo com `offline_access` habilitado e pedido certinho no
> `scope`. Isolamos a causa testando byte a byte no Postman, sem nenhum código nosso no
> meio: com `Authorization: Basic` (`client_secret_basic`, o método que a documentação e o
> `.well-known/openid-configuration` dizem ser obrigatório), o `scope` da resposta **nunca**
> incluía `offline_access` e `refresh_token` nunca vinha — nenhum erro, só descartava o
> escopo silenciosamente. Trocando pra **`client_id` solto no corpo do POST, sem
> `Authorization` nenhum e sem `client_secret` em lugar nenhum** (autenticação `none`, cliente
> público — só o PKCE garante a segurança), `refresh_token` passou a vir normalmente, tanto
> na troca do `code` (`authorization_code`) quanto na renovação (`refresh_token`, que também
> emite um `refresh_token` novo a cada uso — rotação padrão, já tratada no código). Ou seja:
> essa aplicação é tratada como **cliente público** do lado da SoftCS, não confidencial, e a
> doc deles está desatualizada/errada nesse ponto — `client_secret_basic` com Basic Auth
> simplesmente não funciona como documentado. `api/softcs-oauth.js` e `lib/softcs-api.js` já
> foram atualizados pra esse padrão. `getValidAccessToken()` renova sozinho quando o
> `access_token` está perto de expirar (checado no início de toda chamada), e
> `renewTokenAtCycleEnd()` (chamado no fim de cada ciclo do polling, sem pular nenhuma
> finalização — ver "Detecção via polling") garante essa renovação mesmo se um dos dois crons
> configurados falhar num ciclo específico.

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

Essas cinco são obrigatórias, tanto no `.env` local quanto no painel do projeto na Vercel:

- `DATABASE_URL` — connection string do Neon
- `TELEGRAM_BOT_TOKEN` — token do bot, criado com [@BotFather](https://t.me/BotFather)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — credenciais OAuth2 do Google pro login do
  painel (ver passo 4)
- `CRON_SECRET` — segredo que autentica as chamadas periódicas em `/api/poll-tickets` (ver
  passo 6, feitas pelo cron externo cron-job.org). Gere um valor aleatório com:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

E mais duas **opcionais**:

- `GITHUB_DISPATCH_TOKEN` — personal access token do GitHub, usado só pra disparar os
  workflows de polling na hora assim que você clica em **Conectar** (ver passo 6.1), em vez de
  esperar o próximo tick do cron externo (cron-job.org, roda a cada 2/10min — ver "Detecção
  via polling"). Menos crítico agora que `refresh_token` funciona (token se renova sozinho,
  raramente é preciso reconectar), mas ainda dá um empurrão pra pegar mudanças recentes na
  hora, sem esperar o próximo tick. Sem essa variável, tudo continua funcionando normal, só
  sem esse empurrão.
- `TELEGRAM_WEBHOOK_SECRET` — segredo pro webhook de entrada do Telegram (bot recebendo
  mensagem, não só enviando), necessário só pro comando `/status` (ver passo 5.1). Sem essa
  variável, o resto do bot funciona normal, só o `/status` fica indisponível.

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
3. Clique em **Conectar** — conclui o fluxo OAuth2 (Authorization Code + PKCE). A aba
   navega pra SoftCS (inevitável, é OAuth de verdade) e volta sozinha pro painel assim que
   o token é salvo — sem página morta pra fechar manualmente. (Uma janela popup pra evitar
   até essa navegação foi tentada e abandonada: bloqueador de popup do navegador e
   Cross-Origin-Opener-Policy causavam falhas diferentes, fora do nosso controle.)
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

**Enviando só pra um Tópico específico dentro de um grupo**: grupos em modo fórum (ex: um
grupo com abas/subdivisões tipo "Geral", "Notificações") têm **Tópicos**, cada um com seu
próprio `thread_id` — sem preencher isso, a mensagem vai pro grupo inteiro (tópico "Geral").
A API do Telegram não lista os tópicos existentes, só devolve o id de um quando alguém posta
nele — pra descobrir: mande qualquer mensagem dentro do tópico desejado (com o bot no grupo)
e acesse `https://api.telegram.org/bot<TOKEN>/getUpdates`; o `message_thread_id` aparece no
JSON da mensagem. Cole esse número no campo "thread_id do tópico" ao cadastrar o chat (ou
edite depois direto no banco, `update telegram_chats set thread_id = '...' where chat_id =
'...'`) — o `chat_id` continua sendo o do grupo, igual a qualquer outro chat.

### 5.1. Comandos `/status` e `/stop` (inscrição pessoal no privado)

Além de mandar notificação pros grupos/chats cadastrados, um agente pode falar **no privado**
com o bot e mandar `/status` — se o `@usuário` do Telegram dele bater com o que está
cadastrado na aba Agentes, o bot passa a mandar uma cópia de toda notificação de ticket criado
por ele também nesse DM, além de onde já ia antes. Fica valendo permanentemente, independente
de qualquer atualização/mudança no sistema — não precisa repetir o comando toda vez. Pra
parar, a própria pessoa manda `/stop` a qualquer momento (desativa só o chat dela, sem precisar
de administrador); pra reativar depois, é só mandar `/status` de novo.

Cada inscrição via `/status` (`telegram_chats.is_personal = true`) aparece na aba **Chats**,
numa lista separada dos grupos ("Inscrições pessoais") — mostra o nome do agente, permite
desativar manualmente e testar o envio, igual a qualquer outro chat, só sem o painel de
membros (aqui o "membro" é sempre o próprio dono do chat).

Por segurança, o bot **nunca confia num `@usuário` digitado** pela pessoa — ele usa o
`@usuário` que o próprio Telegram manda (verificado, vem no update), então não dá pra alguém
digitar o `@` de um colega e começar a receber os tickets dele. Se a pessoa não tiver
`@usuário` público configurado no Telegram, ou se não estiver cadastrada na aba Agentes com
esse mesmo `@`, o bot explica o que falta em vez de aceitar qualquer coisa digitada.

Pra habilitar esse comando, é preciso registrar um webhook de entrada (diferente do que já
existe hoje, que só *envia* mensagem — isso aqui faz o bot *receber*):

1. Gere um segredo aleatório e cadastre como env var `TELEGRAM_WEBHOOK_SECRET` na Vercel (e
   no `.env` local, se for testar por aqui):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. Depois do deploy, registre o webhook uma vez (troque `<TOKEN>`, `<SECRET>` e
   `SEU-DOMINIO`):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://SEU-DOMINIO.vercel.app/api/telegram-webhook" \
     -d "secret_token=<SECRET>"
   ```
3. Confirme que registrou certo: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` deve
   mostrar a URL cadastrada sem `last_error_message`.

Sem `TELEGRAM_WEBHOOK_SECRET` configurado, o comando `/status` simplesmente não funciona
(webhook nunca registrado) — o resto do bot (envio de notificação) continua normal, não
depende disso.

### 6. Ligar o polling (cron externo — cron-job.org)

Sem webhook disponível na SoftCS (ver "Por que polling, não webhook" acima), quem detecta
mudança é `api/poll-tickets.js`, chamado periodicamente por um cron externo. **Não é o
`schedule:` do GitHub Actions** — testamos isso primeiro, mas o agendador do GitHub atrasa
demais pra esse uso (~1h de gap real mesmo configurado pra 5/15min — ver aviso em "Detecção
via polling"). [cron-job.org](https://cron-job.org) é gratuito, confiável nesse intervalo e
não exige cartão.

1. Crie uma conta gratuita em [cron-job.org](https://cron-job.org).
2. **Job 1** — reconfirma tickets já conhecidos:
   - URL: `https://SEU-DOMINIO.vercel.app/api/poll-tickets?phase=known`
   - Execution schedule: **a cada 2 minutos**
   - Em **Advanced > Request headers**, adicione `Authorization: Bearer <CRON_SECRET>`
     (o mesmo valor da env var `CRON_SECRET` na Vercel — passo 2).
3. **Job 2** — descoberta de tickets novos:
   - URL: `https://SEU-DOMINIO.vercel.app/api/poll-tickets`
   - Execution schedule: **a cada 10 minutos**
   - Mesmo header `Authorization: Bearer <CRON_SECRET>`.
4. Pra não esperar pra testar, use o botão **Run now**/**Test run** de cada job no
   cron-job.org, ou dispare direto:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://SEU-DOMINIO.vercel.app/api/poll-tickets?phase=known`.

Os workflows [poll-known.yml](.github/workflows/poll-known.yml) e
[poll-tickets.yml](.github/workflows/poll-tickets.yml) continuam no repositório (chamam o
mesmo endpoint), mas só disparam via `workflow_dispatch` (manual, ou automático ao reconectar
— ver 6.1) — não têm mais `schedule:`, exatamente pra não competir/duplicar com o cron
externo, que é quem garante o intervalo de verdade agora.

Na primeira execução depois de configurado, o polling entra em **modo seed** automaticamente
(grava o estado de todos os tickets abertos sem notificar ninguém — senão inundaria os
chats) e só passa a notificar normalmente a partir da segunda varredura completa. Isso é
esperado, não é bug.

#### 6.1. Disparo automático ao reconectar (opcional)

`api/softcs-oauth.js` dispara os dois workflows do GitHub Actions na hora, assim que o token é
salvo, via `lib/github-actions.js` — um empurrão extra pra pegar mudanças recentes sem esperar
o próximo tick do cron-job.org. Menos crítico agora que `refresh_token` funciona de verdade
(o token se renova sozinho — reconectar manualmente deixou de ser algo rotineiro), mas ainda
útil logo depois de reconectar por qualquer motivo (ex: revogação manual, troca de app OAuth).

1. No GitHub, vá em **Settings (da sua conta) > Developer settings > Personal access tokens
   > Fine-grained tokens > Generate new token**.
2. Em **Repository access**, escolha **Only select repositories** e selecione só o
   `SoftCS-Bot`.
3. Em **Permissions > Repository permissions**, dê **Actions: Read and write**.
4. Gere o token e cadastre como env var `GITHUB_DISPATCH_TOKEN` na Vercel (e no `.env`
   local, se for testar isso localmente) — faça um redeploy depois.
5. Ainda em **Settings > Secrets and variables > Actions** do repositório, crie um secret
   chamado `CRON_SECRET` com o mesmo valor da env var na Vercel — os workflows continuam
   precisando dele pra autenticar a chamada que fazem, mesmo só disparando via
   `workflow_dispatch` agora.

Sem esse token configurado, a conexão continua funcionando normal, só sem esse empurrão —
o cron-job.org continua rodando nos horários de sempre.

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
  poll-known.yml        roda api/poll-tickets.js?phase=known — reconfirma só os tickets já
                       conhecidos. Só via workflow_dispatch (manual ou ao reconectar); o
                       gatilho periódico de verdade é um cron externo (cron-job.org), não o
                       schedule: do GitHub Actions — ver "Detecção via polling"
  poll-tickets.yml       roda api/poll-tickets.js em loop de lotes (bash + jq) com backoff se
                        a SoftCS responder 429 — descobre tickets novos. Mesma nota: só
                        workflow_dispatch, gatilho periódico é o cron externo
api/
  webhook.js            código morto por enquanto: endpoint que a SoftCS chamaria a cada
                        evento de ticket, mas não há webhook disponível na plataforma (ver
                        "Por que polling, não webhook"). Não exige sessão — seria chamado
                        pela SoftCS, não por um navegador logado.
  poll-tickets.js         chamado pelo cron externo (cron-job.org), duas fases: ?phase=known
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
  discover-tickets.js         três modos: padrão escaneia um lote de clientes ao vivo
                              (?offset=) e devolve os tickets abertos deles (botão "Buscar
                              tickets"); ?phase=known reconfirma ao vivo só os clientes
                              já em ticket_state primeiro (mesma prioridade do polling);
                              ?source=stored lê o snapshot de ticket_state (o que o painel
                              carrega sozinho ao abrir a página). Os dois primeiros também
                              usam processTicket() — a busca manual grava e notifica igual
                              ao polling automático, não é só um preview
  stage-labels.js                 nomes das colunas do Kanban (cadastrados manualmente)
  import-agents.js                importa nome/e-mail em lote (JSON ou stream RSC colado)
  telegram-test.js                  manda uma mensagem de teste pra um chat_id (botão "Testar")
  telegram-webhook.js                 recebe update de ENTRADA do bot (Telegram chamando a
                                     gente, não o contrário) — trata /status e /stop (ver
                                     README "Comandos /status e /stop"). Autenticado pelo header
                                     secreto do setWebhook (TELEGRAM_WEBHOOK_SECRET), não por
                                     sessão nem CRON_SECRET
vercel.json            reescreve /api/auth-start, /api/auth-callback, /api/auth-logout,
                       /api/me, /api/users, /api/oauth-start e /api/oauth-callback pros
                       arquivos consolidados acima (com ?action=...) — as URLs externas não
                       mudam, só a implementação por trás. Existe porque o plano Hobby da
                       Vercel limita a 12 Serverless Functions por deployment, e um arquivo
                       por rota estourava isso (chegou a 15; hoje são exatamente 12, no limite).
lib/
  db.js                 conexão com o Neon
  auth.js                 sessão/cookie, checagem de domínio @chatbotmaker.io + allowlist,
                          requireSession/requireMaster usados por quase todo /api/*
  ticket-scan.js           helpers de varredura em lote (extractItems, extractStage,
                          mapWithConcurrency etc.), compartilhados por discover-tickets.js
                          e poll-tickets.js
  ticket-notify.js          notifyTicketEvent() resolve @menção + nome do estágio + chat(s)
                            alvo e manda a mensagem no Telegram (usado por webhook.js e
                            processTicket()); processTicket() compara um ticket com
                            ticket_state, grava e decide se notifica — usado por
                            poll-tickets.js E discover-tickets.js (busca manual também
                            grava/notifica, não só o polling)
  agents.js              busca o @username cadastrado pro criador do ticket
  telegram.js             envio de mensagem via Bot API (um chat ou broadcast pra vários)
  settings.js              leitura/escrita da tabela settings
  softcs-api.js             token OAuth (refresh automático via getValidAccessToken,
                            checado no início de toda chamada; renewTokenAtCycleEnd garante
                            isso também no fim de cada ciclo do polling, sem pular nenhum) +
                            chamadas à API da SoftCS (getClients, getClientTickets)
  github-actions.js          triggerPollWorkflows() dispara poll-known.yml e
                            poll-tickets.yml na hora via API do GitHub — chamado logo depois
                            de uma reconexão OAuth bem-sucedida (GITHUB_DISPATCH_TOKEN)
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
