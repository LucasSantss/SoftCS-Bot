import sql from '../lib/db.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { requireSession } from '../lib/auth.js';

const EDITABLE_KEYS = ['softcs_client_id', 'softcs_client_secret', 'softcs_redirect_uri'];

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const settings = await getSettings();
    const tokenRows = await sql`select 1 from softcs_oauth_tokens where id = 1`;

    res.status(200).json({
      oauth_connected: tokenRows.length > 0,
      softcs_client_id: settings.softcs_client_id ?? '',
      softcs_client_secret: settings.softcs_client_secret ?? '',
      softcs_redirect_uri: settings.softcs_redirect_uri ?? '',
    });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    const updates = {};
    for (const key of EDITABLE_KEYS) {
      if (typeof body[key] === 'string') updates[key] = body[key];
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'nada para salvar' });
      return;
    }
    await setSettings(updates);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
