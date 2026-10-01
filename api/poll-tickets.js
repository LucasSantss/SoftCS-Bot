import { getValidAccessToken, renewTokenAtCycleEnd } from '../lib/softcs-api.js';
import { SEED_FLAG_KEY } from '../lib/ticket-notify.js';
import { getSetting, setSettings } from '../lib/settings.js';
import { syncTickets } from '../lib/ticket-sync.js';

const BUSINESS_TIMEZONE = 'America/Sao_Paulo';

// O cron externo bate aqui a cada 2min, sempre antes do timeout
// de auto-suspend do compute Neon (5min no plano Free e não dá pra reduzir),
// então o banco nunca chegava a suspender — ficava "ligado" 24/7 e estourava
// a cota mensal de computação. Suporte só atende seg-sex 9h-18h e sáb
// 9h-14h (horário de Brasília — confirmado com o usuário), então fora dessas
// janelas o polling encerra sem tocar no banco nem na API da SoftCS, deixando
// o compute suspender de verdade.
function isWithinBusinessHours(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday').value;
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour').value, 10);

  if (weekday === 'Sun') return false;
  if (weekday === 'Sat') return hour >= 9 && hour < 14;
  return hour >= 9 && hour < 18;
}

// Chamado periodicamente por um cron externo (cron-job.org), já que a
// SoftCS não expõe webhook de ticket (ver api/webhook.js). Cada chamada é
// uma sincronização completa da conta via POST /tickets/search (ver
// syncTickets em lib/ticket-sync.js) — poucas requisições, sem lotes nem
// cursor. `?phase=` era das duas fases da varredura antiga por cliente e é
// ignorado (as duas URLs do cron continuam funcionando, fazendo o mesmo).
//
// Na primeíssima sincronização depois de configurado, ticket_state está
// vazio — sem o "modo seed", TODOS os tickets abertos da conta disparariam
// notificação de "criado" de uma vez, inundando os chats. Enquanto a flag
// `ticket_poll_seeded` não estiver marcada, só grava o snapshot, sem
// notificar; como toda sincronização agora cobre a conta inteira, a flag é
// marcada logo depois da primeira.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization ?? '';
  if (!secret || authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'não autorizado' });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!isWithinBusinessHours()) {
    res.status(200).json({ skipped: 'fora do horário comercial' });
    return;
  }

  try {
    await getValidAccessToken();

    const seeding = (await getSetting(SEED_FLAG_KEY)) !== 'true';
    const { stats } = await syncTickets({ seeding });
    if (seeding) await setSettings({ [SEED_FLAG_KEY]: 'true' });

    // Garante o token renovado no fim de cada finalização, sem pular
    // nenhuma — ver renewTokenAtCycleEnd em lib/softcs-api.js.
    await renewTokenAtCycleEnd();

    res.status(200).json({ seeding, ...stats });
  } catch (error) {
    console.error('Erro no polling de tickets:', error);
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
