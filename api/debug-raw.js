import { getValidAccessToken, getClients, getClientTickets, getClientContacts } from '../lib/softcs-api.js';

// TEMPORÁRIO: expõe a resposta crua da API da SoftCS pra explorar o que dá
// pra extrair (campos, objetos embutidos, etc.) direto no painel, sem
// precisar caçar log na Vercel. Remover quando não precisar mais.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { type, clientId } = req.query ?? {};
  const limit = Number.parseInt(req.query?.limit, 10) || 20;
  const offset = Number.parseInt(req.query?.offset, 10) || 0;

  try {
    await getValidAccessToken();

    let data;
    if (type === 'clients') {
      data = await getClients(limit, offset);
    } else if (type === 'tickets') {
      if (!clientId) {
        res.status(400).json({ error: 'clientId é obrigatório pra type=tickets' });
        return;
      }
      data = await getClientTickets(clientId, limit, offset);
    } else if (type === 'contacts') {
      if (!clientId) {
        res.status(400).json({ error: 'clientId é obrigatório pra type=contacts' });
        return;
      }
      data = await getClientContacts(clientId, limit, offset);
    } else {
      res.status(400).json({ error: 'type precisa ser "clients", "tickets" ou "contacts"' });
      return;
    }

    res.status(200).json(data);
  } catch (error) {
    if (error.rateLimited) {
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    res.status(500).json({ error: error.message });
  }
}
