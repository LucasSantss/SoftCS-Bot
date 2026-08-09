import { requireSession } from '../lib/auth.js';

// Usado pelo admin.js pra saber quem está logado (mostrar e-mail, e liberar
// a aba Acesso só pro master) e pra detectar sessão expirada/inválida (401)
// e mandar pra tela de login.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const user = await requireSession(req, res);
  if (!user) return;
  res.status(200).json(user);
}
