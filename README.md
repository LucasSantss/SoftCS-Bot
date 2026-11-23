# SoftCS Bot

Bot que acompanha os tickets da SoftCS e avisa no **Slack** quando um ticket muda de coluna. Também mantém uma Lista do Slack, o **Rastreador de tickets**, com uma linha por ticket.

## Como funciona

- **Só mudança de coluna gera mensagem.** Ticket novo não gera aviso: ele entra na Lista em silêncio.
- **Uma mensagem por ticket em cada canal.** Na primeira mudança de coluna, o bot posta a mensagem do ticket no canal, com @menção de quem criou, do responsável e, nos canais KA, do CSM. Nas mudanças seguintes, ele **edita essa mesma mensagem** (que sempre mostra a coluna atual) e escreve o histórico na **thread** ("Em análise → Aguardando Resposta"), mencionando as pessoas de novo.
- **Resolvido** só gera aviso quando o ticket foi movido para uma coluna de encerramento. Quando a SoftCS fecha o ticket só pelo status, ele sai do Kanban sem mensagem.
- **Canais por grupo:** cada canal (KA, Adoção, Suporte, Implantação, Todos) segue um ou mais grupos de jornada da aba Jornadas. "Todos" é um grupo **pega-tudo** e recebe todo ticket. Não existe mais mensagem no privado (DM).
- **Rastreador de tickets (Slack List):** tem as colunas Ticket, Coluna, Status (Aberto / Aguardando resposta / Resolvido), Prioridade, Cliente, Jornada, Criado por, Responsável, CSM, Link e Atualizado em. O bot atualiza a linha sozinho. **Precisa de plano pago do Slack.**
- **Lembrete das 9h:** os canais marcados com "Lembrete 9h" recebem todo dia a lista de tickets parados em "Aguardando Resposta" há 2 dias ou mais.

## Passo a passo: criar o bot no Slack

Você precisa ser admin do workspace do Slack, ou pedir a um admin para aprovar o app no passo 3.

### 1. Criar o app a partir do manifesto

1. Abra <https://api.slack.com/apps> e entre com a sua conta do Slack.
2. Clique em **Create New App** e depois em **From a manifest**.
3. Escolha o seu workspace e clique em **Next**.
4. Na aba **JSON**, apague o que estiver lá e cole todo o conteúdo do arquivo [slack-app-manifest.json](slack-app-manifest.json) deste repositório. Clique em **Next** e depois em **Create**.

O manifesto já define o nome (**SoftCS Bot**) e as permissões que o bot precisa:

| Permissão | Para quê |
|---|---|
| `chat:write` | Postar e editar as mensagens dos tickets |
| `chat:write.public` | Postar em canal público sem precisar convidar o bot |
| `users:read`, `users:read.email` | Achar cada agente no Slack pelo e-mail ou pelo nome, para @mencionar |
| `lists:read`, `lists:write` | Criar e atualizar o Rastreador de tickets |

### 2. (Opcional) Colocar um ícone

Em **Basic Information**, vá até **Display Information**, envie uma imagem em **App icon** e clique em **Save Changes**.

### 3. Instalar no workspace e copiar o token

1. No menu da esquerda, abra **OAuth & Permissions**.
2. Clique em **Install to Workspace** e depois em **Permitir**. Se aparecer **Request to Install**, um admin do Slack precisa aprovar antes.
3. Depois de instalar, copie o **Bot User OAuth Token**. Ele começa com `xoxb-`.

> Trate esse token como senha: não cole ele em chat nem em commit.

### 4. Configurar a Vercel

1. No projeto da Vercel, abra **Settings** e depois **Environment Variables**.
2. Adicione `SLACK_BOT_TOKEN` com o token `xoxb-...` do passo 3.
3. Apague as variáveis antigas `TELEGRAM_BOT_TOKEN` e `TELEGRAM_WEBHOOK_SECRET`.
4. Faça um novo deploy (**Deployments**, depois **⋯** no último deploy e **Redeploy**) para a variável valer.

### 5. Atualizar o banco (Neon)

Rode o arquivo [sql/schema.sql](sql/schema.sql) inteiro no **SQL Editor** do Neon. Ele pode ser rodado mais de uma vez sem problema. Ele faz o seguinte:

- renomeia a tabela `telegram_chats` para `slack_channels` e cria as tabelas novas do Slack;
- **apaga os chats antigos do Telegram**, junto com os membros e grupos de jornada ligados a eles, porque esses IDs não funcionam no Slack. Os grupos de jornada continuam existindo; só o vínculo com os chats antigos sai;
- remove a coluna do @username do Telegram da tabela de agentes.

### 6. Criar os canais no Slack

Crie um canal para cada grupo, por exemplo `#softcs-ka`, `#softcs-adocao`, `#softcs-suporte`, `#softcs-implantacao` e `#softcs-todos`. Em cada um:

1. Se o canal for **privado**, convide o bot com `/invite @SoftCS Bot`. Nos públicos isso é opcional.
2. Copie o **ID do canal**: clique no nome do canal no topo, abra a aba **Sobre** e role até o fim. O ID começa com `C`, por exemplo `C0123ABCDEF`.

### 7. Configurar no painel

1. **Jornadas:** crie os grupos **KA**, **Adoção**, **Suporte** e **Implantação**, cada um com as jornadas correspondentes. Crie também o grupo **Todos** marcado como **pega-tudo**.
   - O grupo KA precisa se chamar exatamente **KA**. É ele que faz o CSM aparecer na mensagem.
2. **Canais:**
   - a linha "Integração Slack" no topo deve mostrar "Conectado ao workspace…". Se mostrar erro, confira o token (passo 3) e o redeploy (passo 4);
   - adicione cada canal com o ID do passo 6 e escolha o grupo de jornada dele;
   - marque **Lembrete 9h** nos canais que devem receber o resumo diário de "Aguardando Resposta";
   - clique em **Testar** em cada canal: deve chegar "✅ Mensagem de teste do SoftCS Bot.".
3. **Agentes:** clique em **Ligar agentes ao Slack**. O bot procura cada pessoa pelo e-mail e, se não achar, pelo nome. Para quem ficar em "Sem Slack", preencha o **ID de membro** à mão: no Slack, abra o perfil da pessoa, clique em **⋮** e depois em **Copiar ID de membro** (começa com `U`).
4. **Canais:** com os canais já cadastrados, clique em **Criar Lista de tickets**. O bot cria a Lista "Rastreador de tickets SoftCS" e dá acesso de edição a todos os canais ativos. Canais cadastrados depois ganham acesso automaticamente.

### 8. Colocar a Lista no canal

Em cada canal, clique no **+** ao lado das abas do topo (Mensagens, Arquivos…), escolha **Lista** e selecione **Rastreador de tickets SoftCS**. Na Lista, você pode trocar a visualização para **Quadro** e agrupar por **Status** ou **Coluna**, no estilo do "Rastreador de feedback".

Na primeira sincronização, os tickets já abertos entram na Lista aos poucos, cerca de 25 por rodada (o Slack limita quantas linhas podem ser criadas por minuto). Em poucas rodadas do polling a Lista fica completa.

### 9. Desligar o bot antigo do Telegram (opcional)

O código do Telegram foi removido. Para o bot antigo parar de vez, apague-o no @BotFather (`/deletebot`) ou só remova-o dos grupos do Telegram.

## Variáveis de ambiente

Veja [.env.example](.env.example). A única variável nova é `SLACK_BOT_TOKEN`.

## Rodar localmente (`npm run dev`)

O dev local usa uma **branch do Neon**, que é uma cópia do banco de produção. Assim a migração do Slack não afeta a versão que está no ar.

1. **Criar a branch:** no Neon, abra **Branches**, clique em **Create branch** (a partir da `main`) e copie a connection string da branch nova.
2. **Rodar a migração na branch:** abra o **SQL Editor** com a branch nova selecionada e rode o [sql/schema.sql](sql/schema.sql).
3. **Preencher o `.env`** (o arquivo já existe, vazio, e está no `.gitignore`):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | connection string da **branch** |
   | `SOFTCS_TOKEN_DATABASE_URL` | connection string da **produção**, usada só para *ler* o token da SoftCS |
   | `SLACK_BOT_TOKEN` | token `xoxb-` (passo 3 acima) |
   | `DEV_LOGIN_EMAIL` | seu e-mail @chatbotmaker.io; entra no painel sem passar pelo Google |

   As outras variáveis podem ficar vazias.
4. **Subir o servidor:**

   ```bash
   npm install
   npm run dev
   ```

   Abra <http://localhost:3000>: o login já é feito sozinho.

Cuidados no dev local:

- **Token da SoftCS:** no modo local o bot nunca renova o token. Ele só lê o token atual da produção, porque renovar a partir da cópia invalidaria o da produção. Fora do horário comercial (quando o cron da produção não roda) o token pode estar vencido, e "Buscar tickets" avisa isso.
- **Mensagens reais:** as mensagens vão para o Slack de verdade, então cadastre canais de teste. O primeiro "Buscar tickets" avisa todas as mudanças de coluna que aconteceram desde a criação da branch.
- **Lista de teste:** a Lista criada no teste fica registrada só na branch. Depois do deploy, a produção cria a dela pelo botão. Apague a Lista de teste no Slack quando terminar.
- **Proteção:** o `npm run dev` se recusa a subir se `DATABASE_URL` for igual a `SOFTCS_TOKEN_DATABASE_URL`, ou seja, se o banco local for o de produção.
