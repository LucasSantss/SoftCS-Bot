import { getSetting } from './settings.js';

// Enquanto nenhuma senha de admin foi definida ainda (primeiro acesso depois do
// deploy), libera o acesso — é assim que o /admin.html consegue "reivindicar" o
// painel na primeira vez, sem precisar de nenhuma env var extra. Depois que uma
// senha existe, ela passa a ser exigida em todo request.
export async function checkAdmin(req) {
  const stored = await getSetting('admin_secret');
  if (!stored) {
    return { authorized: true, bootstrap: true };
  }
  const provided = req.headers['x-admin-secret'];
  return { authorized: provided === stored, bootstrap: false };
}
