import sql from '../lib/db.js';
import { requireSession } from '../lib/auth.js';

// Alguns painéis internos da SoftCS entregam texto em UTF-8 decodificado como
// Latin-1 na hora de copiar (ex: "Ã§Ã£" em vez de "ção") — reverte isso.
function fixMojibake(text) {
  try {
    return Buffer.from(text, 'latin1').toString('utf8');
  } catch {
    return text;
  }
}

// Aceita tanto um JSON array puro quanto o stream RSC colado direto do
// DevTools (linhas "N:{...}" / "N:[...]"), como a tela de Usuários da SoftCS
// devolve. Extrai qualquer objeto com {id, email} de dentro de qualquer
// array encontrado (em qualquer profundidade) e ignora o resto.
function extractUsers(rawText) {
  const text = fixMojibake(rawText);
  const usersById = new Map();

  function collect(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && item.id && item.email) {
          usersById.set(item.id, { id: item.id, name: item.name || null, email: item.email });
        } else {
          collect(item);
        }
      }
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) collect(v);
    }
  }

  try {
    collect(JSON.parse(text));
    if (usersById.size > 0) return [...usersById.values()];
  } catch {
    // não é um JSON único — cai pro parser linha a linha do stream RSC
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\d+:(.*)$/);
    const jsonPart = (match ? match[1] : line).trim();
    if (!jsonPart) continue;
    try {
      collect(JSON.parse(jsonPart));
    } catch {
      // linha que não é JSON válido (ex: a linha de metadados "0:") — ignora
    }
  }

  return [...usersById.values()];
}

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const raw = req.body?.raw;
  if (!raw || typeof raw !== 'string') {
    res.status(400).json({ error: 'raw (texto colado) é obrigatório' });
    return;
  }

  const users = extractUsers(raw);
  if (users.length === 0) {
    res.status(400).json({ error: 'Nenhum usuário com id + email encontrado nesse texto.' });
    return;
  }

  for (const user of users) {
    await sql`
      insert into agent_mapping (softcs_user_id, display_name, email)
      values (${user.id}, ${user.name}, ${user.email})
      on conflict (softcs_user_id) do update set
        display_name = excluded.display_name,
        email = excluded.email,
        updated_at = now()
    `;
  }

  res.status(200).json({ ok: true, imported: users.length });
}
