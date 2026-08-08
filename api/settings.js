import sql from '../lib/db.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { checkAdmin } from '../lib/auth.js';

const EDITABLE_KEYS = [
  'admin_secret',
  'softcs_client_id',
  'softcs_client_secret',
  'softcs_redirect_uri',
  'softcs_webhook_secret',
];

export default async function handler(req, res) {
  const { authorized, bootstrap } = await checkAdmin(req);

  if (!authorized) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const settings = await getSettings();
    const tokenRows = await sql`select 1 from softcs_oauth_tokens where id = 1`;

    res.status(200).json({
      bootstrap,
      oauth_connected: tokenRows.length > 0,
      admin_secret: settings.admin_secret ?? '',
      softcs_client_id: settings.softcs_client_id ?? '',
      softcs_client_secret: settings.softcs_client_secret ?? '',
      softcs_redirect_uri: settings.softcs_redirect_uri ?? '',
      softcs_webhook_secret: settings.softcs_webhook_secret ?? '',
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
