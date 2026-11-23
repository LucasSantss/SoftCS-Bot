const SLACK_API = 'https://slack.com/api';

// Erros comuns da Web API com o que fazer — aparecem no painel (botão
// Testar, Criar Lista...) e nos logs, em vez de só o código do Slack.
const ERROR_HINTS = {
  channel_not_found:
    'o bot não enxerga esse canal. Se for privado, rode /invite @SoftCS Bot dentro dele; senão confira o ID (aba "Sobre" do canal, cuidado com O x 0) e se o canal é do mesmo workspace onde o app foi instalado',
  not_in_channel: 'o bot não está no canal — rode /invite @SoftCS Bot dentro dele',
  is_archived: 'o canal está arquivado',
  invalid_auth: 'SLACK_BOT_TOKEN inválido — copie de novo o "Bot User OAuth Token" (xoxb-) e faça redeploy',
  not_authed: 'SLACK_BOT_TOKEN não enviado — configure a variável e faça redeploy',
  account_inactive: 'o app foi desinstalado do workspace — instale de novo em OAuth & Permissions',
  missing_scope: 'falta uma permissão no app — confira os escopos do slack-app-manifest.json e reinstale o app',
  team_access_not_granted: 'o app não foi instalado nesse workspace',
  lists_disabled_user_team: 'Lists não está disponível nesse workspace (precisa de plano pago)',
};

// Chamada genérica à Web API do Slack (docs.slack.dev/apis/web-api) com o
// token do bot (xoxb-...). Toda resposta vem com HTTP 200 e `ok: false` em
// caso de erro — por isso a checagem é no corpo, não no status. 429 =
// rate limit (Retry-After em segundos): marca o erro pra quem chamou poder
// pular sem derrubar a sincronização inteira.
export async function slackApi(method, body = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN não configurado');

  const response = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const error = new Error(`Slack ${method}: rate limit`);
    error.rateLimited = true;
    error.retryAfterSeconds = Number(response.headers.get('retry-after')) || null;
    throw error;
  }

  const data = await response.json();
  if (!data.ok) {
    const hint = ERROR_HINTS[data.error];
    const error = new Error(
      `Slack ${method}: ${data.error}${hint ? ` — ${hint}` : ''}${data.errors ? ` (${JSON.stringify(data.errors)})` : ''}`
    );
    error.slackError = data.error;
    throw error;
  }
  return data;
}

// Escapa texto livre (título de ticket, nome de cliente) pro mrkdwn do
// Slack — só &, < e > têm significado especial (docs: "Escaping text").
export function escapeMrkdwn(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function slackLink(url, label) {
  return `<${url}|${escapeMrkdwn(label)}>`;
}

// `channel` = ID do canal (C…/G…). `threadTs` = ts da mensagem-mãe, pra
// responder na thread. O bot precisa estar no canal (/invite @SoftCS Bot).
export function postMessage({ channel, text, blocks, threadTs }) {
  return slackApi('chat.postMessage', {
    channel,
    text,
    ...(blocks ? { blocks } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
}

export function updateMessage({ channel, ts, text, blocks }) {
  return slackApi('chat.update', { channel, ts, text, ...(blocks ? { blocks } : {}) });
}

// Manda pra vários canais; erro num canal (ex: bot fora do canal) não
// derruba o envio pros outros. Devolve os resultados na mesma ordem.
export async function postToChannels(channels, message) {
  const results = await Promise.allSettled(channels.map((channel) => postMessage({ channel, ...message })));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Falha ao enviar para o canal ${channels[i]}:`, r.reason?.message ?? r.reason);
  });
  return results;
}
