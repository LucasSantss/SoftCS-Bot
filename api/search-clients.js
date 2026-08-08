import { getValidAccessToken, getClients } from '../lib/softcs-api.js';

function extractItems(response) {
  if (Array.isArray(response)) return response;
  return response.data ?? response.items ?? [];
}

// Busca cliente por nome, pra escolher qual usar na aba Tickets — evita ter
// que escanear os milhares de clientes da conta pra achar um só.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const q = (req.query?.q ?? '').trim();
  if (!q) {
    res.status(200).json({ clients: [] });
    return;
  }

  try {
    await getValidAccessToken();
    const response = await getClients(20, 0, q);
    const clients = extractItems(response).map((c) => ({ id: c.id, name: c.name }));
    res.status(200).json({ clients });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
