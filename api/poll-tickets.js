import sql from '../lib/db.js';
import { getValidAccessToken, getClients, getClientTickets } from '../lib/softcs-api.js';
import { notifyTicketEvent } from '../lib/ticket-notify.js';
import { getSetting, setSettings } from '../lib/settings.js';
import {
  CLIENT_PAGE_LIMIT,
  TICKETS_PER_CLIENT,
  TICKET_CONCURRENCY,
  extractItems,
  extractStage,
  extractClientName,
  mapWithConcurrency,
} from '../lib/ticket-scan.js';

const SEED_FLAG_KEY = 'ticket_poll_seeded';

// Chamado pelo workflow do GitHub Actions (.github/workflows/poll-tickets.yml)
// a cada 15min, em loop de lotes (mesmo padrão de api/discover-tickets.js —
// um lote de clientes por chamada, offset/nextOffset controla a paginação),
// já que a SoftCS não expõe webhook de ticket (ver api/webhook.js). Cada
// ticket aberto encontrado é comparado com o snapshot em ticket_state: sem
// linha = ticket novo (notifica "criado" e grava); stage_id diferente =
// ticket se moveu de coluna (notifica "atualizado" e atualiza). Não detecta
// outras mudanças (título, prioridade, etc.) — só criação e movimentação de
// estágio, que é o que foi pedido.
//
// Na primeíssima varredura depois de configurado, ticket_state está vazio —
// sem o "modo seed", TODOS os tickets abertos da conta (podem ser
// centenas/milhares) disparariam notificação de "criado" de uma vez só,
// inundando os chats. Enquanto a flag `ticket_poll_seeded` não estiver
// marcada, a varredura só grava o snapshot, sem notificar; a flag é marcada
// quando o último lote dessa primeira varredura termina (hasMoreClients
// vira false), e daí em diante o polling passa a notificar normalmente.
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

  const offset = Number.parseInt(req.query?.offset, 10) || 0;

  try {
    await getValidAccessToken();

    const seeding = (await getSetting(SEED_FLAG_KEY)) !== 'true';

    const clientsResponse = await getClients(CLIENT_PAGE_LIMIT, offset);
    const clients = extractItems(clientsResponse);
    const clientNameById = new Map(clients.map((c) => [c.id, c.name]));
    const clientPagination = clientsResponse?.pagination;

    const stageLabelRows = await sql`select stage_id, label from stage_labels`;
    const stageLabels = Object.fromEntries(stageLabelRows.map((r) => [r.stage_id, r.label]));

    const ticketLists = await mapWithConcurrency(clients, TICKET_CONCURRENCY, (client) =>
      getClientTickets(client.id, TICKETS_PER_CLIENT, 0).catch((err) => {
        console.error(`Falha ao buscar tickets do cliente ${client.id}:`, err.message);
        return null;
      })
    );

    let ticketsSeen = 0;
    let notified = 0;

    for (const ticketsResponse of ticketLists) {
      if (!ticketsResponse) continue;

      for (const ticket of extractItems(ticketsResponse)) {
        if (ticket.closedAt) continue; // só tickets abertos
        ticketsSeen += 1;

        const stage = extractStage(ticket, stageLabels);
        const previousRows = await sql`select stage_id from ticket_state where ticket_id = ${ticket.id}`;
        const previous = previousRows[0];

        if (!previous) {
          await sql`
            insert into ticket_state (ticket_id, public_id, stage_id, title, created_by_id)
            values (${ticket.id}, ${ticket.publicId ?? null}, ${stage.id}, ${ticket.title ?? null}, ${ticket.createdById ?? null})
            on conflict (ticket_id) do nothing
          `;
          if (!seeding) {
            await notifyTicketEvent({
              kind: 'created',
              title: ticket.title,
              priority: ticket.priority,
              publicId: ticket.publicId,
              clientName: extractClientName(ticket, clientNameById),
              stageId: stage.id,
              createdById: ticket.createdById,
            });
            notified += 1;
          }
        } else if (previous.stage_id !== stage.id) {
          await sql`
            update ticket_state
            set stage_id = ${stage.id}, title = ${ticket.title ?? null}, updated_at = now()
            where ticket_id = ${ticket.id}
          `;
          if (!seeding) {
            await notifyTicketEvent({
              kind: 'updated',
              title: ticket.title,
              priority: ticket.priority,
              publicId: ticket.publicId,
              clientName: extractClientName(ticket, clientNameById),
              stageId: stage.id,
              createdById: ticket.createdById,
            });
            notified += 1;
          }
        }
      }
    }

    const hasMoreClients = Boolean(clientPagination?.hasMore);
    if (seeding && !hasMoreClients) {
      await setSettings({ [SEED_FLAG_KEY]: 'true' });
    }

    res.status(200).json({
      seeding,
      clientsScanned: clients.length,
      ticketsSeen,
      notified,
      hasMoreClients,
      nextOffset: clientPagination?.nextOffset ?? offset + clients.length,
    });
  } catch (error) {
    console.error('Erro no polling de tickets:', error);
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
