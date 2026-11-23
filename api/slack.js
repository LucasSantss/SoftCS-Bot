import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { slackApi, postMessage } from '../lib/slack.js';
import { isWebhookTarget, postWorkflowWebhook } from '../lib/slack-webhook.js';
import { syncSlackUsers } from '../lib/slack-users.js';
import { createTrackerList, getTrackerList } from '../lib/slack-list.js';
import { getOverdueAwaitingResponseTickets, buildAwaitingResponseMessages } from '../lib/awaiting-response.js';

// Ações do painel ligadas ao Slack (uma função só por causa do limite de 12
// Serverless Functions do plano Hobby da Vercel):
// - GET: status da integração (token válido? qual workspace? Lista criada?)
// - POST { action: 'test', chat_id }: mensagem de teste no canal (botão
//   "Testar" da aba Chats) — confirma o ID e que o bot está no canal;
//   com kind: 'awaiting_response', manda a lista real de "Aguardando
//   Resposta" agora, sem mexer no envio automático das 9h;
// - POST { action: 'sync-users' }: liga agentes a usuários do Slack por
//   e-mail/nome (ver lib/slack-users.js);
// - POST { action: 'create-list' }: cria a Lista "Rastreador de tickets"
//   (ver lib/slack-list.js).
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      // Sem token = só modo fluxo de trabalho (webhook), sem bot.
      if (!process.env.SLACK_BOT_TOKEN) {
        res.status(200).json({ ok: true, mode: 'webhook' });
        return;
      }
      const auth = await slackApi('auth.test');
      const list = await getTrackerList();
      res.status(200).json({ ok: true, team: auth.team, botUser: auth.user, listId: list?.listId ?? null });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const { action, chat_id, kind } = req.body ?? {};

    if (action === 'test') {
      if (!chat_id) {
        res.status(400).json({ error: 'chat_id é obrigatório' });
        return;
      }
      if (isWebhookTarget(chat_id)) {
        // Colunas Pessoa precisam de um ID real: usa até 3 agentes que já têm
        // ID do Slack na aba Agentes (vazio se nenhum tiver).
        const ids = (
          await sql`select slack_user_id from agent_mapping where slack_user_id is not null order by display_name limit 3`
        ).map((r) => r.slack_user_id);
        await postWorkflowWebhook(chat_id, {
          evento: 'Teste',
          ticket: 'Ticket de teste do SoftCS Bot',
          coluna: 'Em análise',
          coluna_anterior: 'Novo',
          prioridade: 'P2',
          cliente: 'Cliente de teste',
          jornada: 'Jornada de teste',
          criado_por: 'Fulano',
          responsavel: 'Ciclano',
          csm: 'Beltrano',
          mencoes: '',
          link: 'https://admin.softcs.com.br/pt-br/tickets',
          ticket_id: '0',
          criado_por_id: ids[0] ?? '',
          responsavel_id: ids[1] ?? ids[0] ?? '',
          csm_id: ids[2] ?? ids[0] ?? '',
        });
      } else if (kind === 'awaiting_response') {
        const { tickets } = await getOverdueAwaitingResponseTickets();
        for (const text of buildAwaitingResponseMessages(tickets)) await postMessage({ channel: chat_id, text });
      } else {
        await postMessage({ channel: chat_id, text: '✅ Mensagem de teste do SoftCS Bot.' });
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'sync-users') {
      const result = await syncSlackUsers({ force: req.body?.force === true });
      res.status(200).json({ ok: true, ...result });
      return;
    }

    if (action === 'create-list') {
      const result = await createTrackerList();
      res.status(200).json({ ok: true, ...result });
      return;
    }

    res.status(400).json({ error: 'action inválida' });
  } catch (error) {
    console.error('Erro na integração com o Slack:', error);
    res.status(400).json({ error: error.message });
  }
}
