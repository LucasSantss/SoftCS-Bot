import crypto from 'node:crypto';
import sql from '../lib/db.js';

// Webhook REAL da SoftCS (docs.softcs.com.br/docs/webhooks-de-clientes) —
// diferente do que esse arquivo assumia antes (payload provisório, nunca
// confirmado), agora temos o formato oficial: envelope
// `{ id, type, occurredAt, accountId, applicationId, data: { object, changes },
// source, test }`, assinado no padrão Svix (headers webhook-id/
// webhook-timestamp/webhook-signature). Guarda TODO evento recebido por
// completo em `processed_webhook_events` (ver schema.sql) — não dispara
// notificação nenhuma ainda: quem notifica continua sendo o polling
// (api/poll-tickets.js). Ligar isso aqui na notificação em tempo real é um
// passo separado, de propósito, pra não arriscar duplicar mensagem com o
// polling ainda rodando.
//
// Precisa do corpo BRUTO da requisição pra validar a assinatura (HMAC sobre
// o texto exato recebido — reserializar o JSON quebra a verificação), por
// isso desliga o parsing automático da Vercel (`bodyParser: false`) e lê o
// stream na mão. Localmente, dev-server.js já deixa isso pronto em
// `req.rawBody`.
export const config = { api: { bodyParser: false } };

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // mesma janela que a doc da SoftCS define

async function readRawBody(req) {
  if (req.rawBody != null) {
    return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verificação no padrão Svix, usado pela SoftCS: assinatura =
// base64(HMAC-SHA256(secreto, "{id}.{timestamp}.{corpo}")), chave =
// base64decode(SOFTCS_WEBHOOK_SECRET sem o prefixo "whsec_"). O header
// webhook-signature pode trazer mais de uma assinatura espaço-separadas
// (formato "v1,<base64>" cada) — qualquer uma batendo já é válido.
function verifySoftcsSignature({ id, timestamp, rawBody, signatureHeader, secret }) {
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  const skewSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (skewSeconds > SIGNATURE_TOLERANCE_SECONDS) return false; // proteção contra replay, igual à doc

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return signatureHeader
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const [version, signature] = part.split(',');
      return version === 'v1' && signature && timingSafeEqualStr(signature, expected);
    });
}

// Grava o envelope inteiro (ver schema.sql) — `on conflict do nothing`
// dedupe por `id`, já que a SoftCS reentrega em caso de timeout/erro (até 8x
// em ~24h). `returning event_id` vazio = era duplicata, não reprocessa.
async function storeEvent(envelope) {
  const rows = await sql`
    insert into processed_webhook_events (
      event_id, event_type, occurred_at, account_id, application_id, source, test, object, changes
    ) values (
      ${envelope.id},
      ${envelope.type ?? null},
      ${envelope.occurredAt ?? null},
      ${envelope.accountId ?? null},
      ${envelope.applicationId ?? null},
      ${envelope.source ?? null},
      ${envelope.test === true},
      ${envelope.data?.object ? JSON.stringify(envelope.data.object) : null}::jsonb,
      ${envelope.data?.changes ? JSON.stringify(envelope.data.changes) : null}::jsonb
    )
    on conflict (event_id) do nothing
    returning event_id
  `;
  return rows.length > 0; // true = era novo, gravou; false = duplicata
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const secret = process.env.SOFTCS_WEBHOOK_SECRET;
  if (!secret) {
    console.error('SOFTCS_WEBHOOK_SECRET não configurado — recusando webhook da SoftCS.');
    res.status(500).json({ error: 'webhook não configurado' });
    return;
  }

  const rawBody = await readRawBody(req);
  const valid = verifySoftcsSignature({
    id: req.headers['webhook-id'],
    timestamp: req.headers['webhook-timestamp'],
    signatureHeader: req.headers['webhook-signature'],
    rawBody,
    secret,
  });
  if (!valid) {
    res.status(401).json({ error: 'assinatura inválida' });
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'corpo não é JSON válido' });
    return;
  }

  if (!envelope.id || !envelope.type) {
    res.status(400).json({ error: 'envelope sem id/type' });
    return;
  }

  try {
    const isNew = await storeEvent(envelope);
    res.status(200).json({ ok: true, stored: isNew });
  } catch (error) {
    console.error('Erro gravando evento de webhook da SoftCS:', error);
    res.status(500).json({ error: 'internal error' });
  }
}
