// Modo "fluxo de trabalho" (Workflow Builder do Slack, gatilho "De um
// webhook"): em vez de um bot postando no canal, o painel guarda a URL do
// fluxo (https://hooks.slack.com/triggers/...) e o SoftCS Bot faz um POST com
// as variáveis do ticket. O próprio fluxo decide o que fazer: mandar a
// mensagem no canal, adicionar item à Lista, etc. Não precisa instalar app
// nem de aprovação de admin.
//
// Limites do Slack nesse modo:
// - o fluxo não edita mensagem anterior nem responde na thread dela, então
//   cada mudança de coluna vira uma mensagem (a deduplicação continua: uma
//   por mudança, nunca repetida);
// - 1 requisição por segundo por webhook (ver throttle abaixo);
// - toda variável configurada no fluxo precisa vir no corpo, senão o fluxo
//   falha — por isso todas as chaves vão sempre, vazias quando não há valor
//   (WEBHOOK_KEYS precisa bater com as variáveis criadas no fluxo).

export const WEBHOOK_URL_PREFIX = 'https://hooks.slack.com/triggers/';

export const WEBHOOK_KEYS = [
  'evento',
  'ticket',
  'coluna',
  'coluna_anterior',
  'prioridade',
  'cliente',
  'jornada',
  'criado_por',
  'responsavel',
  'csm',
  'mencoes',
  'link',
  'ticket_id',
];

export function isWebhookTarget(target) {
  return typeof target === 'string' && target.startsWith(WEBHOOK_URL_PREFIX);
}

// Mostra só o começo e o fim da URL — quem tem a URL inteira consegue
// disparar o fluxo.
export function maskWebhookUrl(url) {
  return `${url.slice(0, WEBHOOK_URL_PREFIX.length + 4)}…${url.slice(-4)}`;
}

const MIN_INTERVAL_MS = 1100;
const queues = new Map(); // url -> promise da última chamada

// Serializa as chamadas por URL com ~1,1 s entre elas (limite do Slack).
export function postWorkflowWebhook(url, variables) {
  const body = Object.fromEntries(WEBHOOK_KEYS.map((key) => [key, String(variables[key] ?? '')]));
  const previous = queues.get(url) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS));
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Fluxo do Slack respondeu ${response.status}${text ? `: ${text.slice(0, 200)}` : ''} — confira se a URL está certa, ` +
            `se o fluxo está publicado e se as variáveis dele são exatamente: ${WEBHOOK_KEYS.join(', ')}`
        );
      }
    });
  queues.set(url, next);
  return next;
}
