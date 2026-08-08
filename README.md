# SoftCS → Telegram

Recebe o payload do webhook de ticket da SoftCS e posta um resumo em um ou mais chats do
Telegram, mencionando quem criou o ticket (`@username`), usando um mapeamento manual entre
o ID de usuário da SoftCS e o `@username` no Telegram. O caminho do webhook em si
(`api/webhook.js`) não usa a API autenticada da SoftCS — só recebe o POST e monta a
mensagem com o que vier nele. A API autenticada (OAuth2) é usada só pela busca "Buscar da
SoftCS" na aba Agentes, pra descobrir nomes de quem criou os tickets.

Só existem duas variáveis de ambiente: `DATABASE_URL` e `TELEGRAM_BOT_TOKEN`. Tudo o resto
(credenciais OAuth2 da SoftCS, mapeamento de agentes, chats do Telegram) é cadastrado
depois do deploy direto na URL do domínio (`index.html`), e fica salvo no Neon.

> ⚠️ **O painel não tem senha nenhuma** — foi uma escolha deliberada (uso pessoal, sem
> fricção de login). Qualquer pessoa com a URL do domínio consegue ver e editar tudo,
> incluindo o `client_secret` da SoftCS. Não divulgue essa URL.

> ⚠️ **Pendência conhecida**: o parser em [api/webhook.js](api/webhook.js) foi escrito
> com um formato de payload provisório (`{ event, eventId, data: { title, priority,
> createdById, ... } }`), pois a documentação pública da SoftCS não descreve o corpo do
> webhook — só a tela de configuração dentro do painel mostra isso. Assim que você tiver
> um evento de teste real (o painel geralmente tem um botão "enviar teste"), ajuste
> `parsePayload()` em `api/webhook.js` para bater com os campos reais.

## Como funciona o mapeamento de agentes

A API pública da SoftCS (`/clients/{clientId}/tickets`) documenta o campo do ticket como
`createdById` — só um ID, sem nome. Na prática, porém, a resposta real de alguns tickets
trouxe um objeto `createdBy: { id, name, email }` embutido — é isso que
`api/discover-creators.js` tenta ler. Se a sua conta não retornar esse objeto expandido,
a busca ainda funciona, só que sem nome (você vê apenas o ID e precisa identificar a
pessoa de outra forma).

Na aba **Agentes**:

- **Buscar da SoftCS**: conecta a aplicação OAuth2 (Client ID/Secret/Redirect URI) e
  busca os tickets dos primeiros clientes retornados, extraindo os criadores únicos
  (nome + e-mail, quando disponíveis). Você só preenche o `@` de cada um.
- **Novo agente**: cadastro manual (ID + `@` + nome opcional), pra quando preferir digitar
  direto ou a busca não trouxer nome.

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

### 4. Cadastrar agentes e chats

Acesse `https://SEU-DOMINIO.vercel.app/` — o painel é a própria raiz do domínio
(`index.html`), não precisa de nenhum caminho extra.

Na aba **Agentes**, seção "Buscar da SoftCS":

1. Crie uma aplicação OAuth2 em Configurações > Aplicações no painel da SoftCS, com
   redirect URI `https://SEU-DOMINIO.vercel.app/api/oauth-callback`.
2. Preencha Client ID, Client Secret e Redirect URI no painel e clique em **Salvar**.
3. Clique em **Conectar** — conclui o fluxo OAuth2 (Authorization Code + PKCE) e salva o
   token no Neon (renovado automaticamente depois, via `lib/softcs-api.js`).
4. Clique em **Buscar tickets** — lista os criadores únicos encontrados; preencha o `@`
   e salve cada um.

Na aba **Chats**: cada grupo/canal que deve receber as notificações. Descubra o `chat_id`
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
`TELEGRAM_BOT_TOKEN`. Pra testar a conexão OAuth2 localmente, cadastre
`http://localhost:3000/api/oauth-callback` como Redirect URI tanto no painel quanto na
aplicação OAuth2 da SoftCS.

## Estrutura

```
index.html             painel único (sem login), servido na raiz do domínio: abas Agentes e Chats
admin.css               visual baseado no design system do CodeRise Hub
admin.js                 lógica das abas (fetch nas APIs abaixo)
api/
  webhook.js            endpoint que a SoftCS chama a cada evento de ticket
  agents.js              CRUD do mapeamento agente SoftCS -> @telegram
  chats.js                CRUD dos chats do Telegram
  settings.js              credenciais OAuth da SoftCS (tabela settings)
  oauth-start.js            passo 1 da conexão OAuth (botão "Conectar")
  oauth-callback.js          passo 2 da conexão OAuth
  discover-creators.js        busca tickets na SoftCS e extrai os criadores únicos
lib/
  db.js                 conexão com o Neon
  agents.js              busca o @username cadastrado pro criador do ticket
  telegram.js             envio de mensagem via Bot API (um chat ou broadcast pra vários)
  settings.js              leitura/escrita da tabela settings
  softcs-api.js             token OAuth (refresh automático) + chamadas à API da SoftCS
sql/
  schema.sql            tabelas: agent_mapping, processed_webhook_events, telegram_chats,
                         settings, softcs_oauth_tokens, oauth_pkce_state
dev-server.js          servidor local leve pra `npm run dev` (sem precisar de vercel CLI)
```
