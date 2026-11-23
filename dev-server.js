// Servidor local simples para testar as functions sem precisar de `vercel login`.
// Roda com: node --env-file=.env dev-server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Confere o .env antes de subir, com mensagem clara em vez de um erro 500
// na primeira requisição.
if (!process.env.DATABASE_URL) {
  console.error(
    '\n✗ DATABASE_URL não configurada.\n' +
      '  Copie .env.example para .env e preencha (seção "Dev local" no fim do arquivo).\n'
  );
  process.exit(1);
}
// Proteção: o dev local roda numa BRANCH do Neon, nunca na produção — a
// migração do Slack (sql/schema.sql) quebraria a versão que está no ar.
if (process.env.SOFTCS_TOKEN_DATABASE_URL && process.env.SOFTCS_TOKEN_DATABASE_URL === process.env.DATABASE_URL) {
  console.error(
    '\n✗ DATABASE_URL é igual a SOFTCS_TOKEN_DATABASE_URL (produção).\n' +
      '  Use em DATABASE_URL a connection string da branch do Neon criada pra teste.\n'
  );
  process.exit(1);
}
for (const [name, hint] of [
  ['SLACK_BOT_TOKEN', 'mensagens e Lista do Slack não vão funcionar'],
  ['SOFTCS_TOKEN_DATABASE_URL', '"Buscar tickets" vai usar (e RENOVAR) o token da SoftCS da branch — isso invalida o token da produção'],
  ['DEV_LOGIN_EMAIL', 'o login vai pelo Google, que precisa ter http://localhost:' + PORT + '/api/auth-callback cadastrado'],
]) {
  if (!process.env[name]) console.warn(`⚠ ${name} não configurada — ${hint}.`);
}

// Login local sem Google: cria uma sessão pro DEV_LOGIN_EMAIL (precisa ser o
// master ou estar na aba Acesso) e volta pro painel. Só existe aqui no
// dev-server (a Vercel nunca roda este arquivo) e só aceita requisição da
// própria máquina.
async function handleDevLogin(req, res) {
  const email = process.env.DEV_LOGIN_EMAIL;
  const remote = req.socket.remoteAddress ?? '';
  if (!email || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const { createSession, setSessionCookie, isEmailAllowed } = await import('./lib/auth.js');
  if (!(await isEmailAllowed(email))) {
    res.statusCode = 403;
    res.end(`${email} não tem acesso ao painel (aba Acesso).`);
    return;
  }
  const { token, expiresAt } = await createSession(email);
  setSessionCookie(res, token, expiresAt);
  res.writeHead(302, { Location: '/' });
  res.end();
}

// Alguns caminhos aqui viram a mesma function em produção (vercel.json faz o
// rewrite pra /api/auth?action=... e /api/softcs-oauth?action=...) — o
// segundo elemento simula isso localmente, injetando `action` em req.query
// antes de chamar o handler, sem mudar nenhuma URL externa.
const routes = {
  '/api/webhook': ['./api/webhook.js'],
  '/api/chats': ['./api/chats.js'],
  '/api/journey-groups': ['./api/chats.js', 'groups'],
  '/api/agents': ['./api/agents.js'],
  '/api/settings': ['./api/settings.js'],
  '/api/discover-tickets': ['./api/discover-tickets.js'],
  '/api/poll-tickets': ['./api/poll-tickets.js'],
  '/api/export-tickets': ['./api/discover-tickets.js', 'export'],
  '/api/slack': ['./api/slack.js'],
  '/api/stage-labels': ['./api/stage-labels.js'],
  '/api/import-agents': ['./api/import-agents.js'],
  '/api/oauth-start': ['./api/softcs-oauth.js', 'start'],
  '/api/oauth-callback': ['./api/softcs-oauth.js', 'callback'],
  '/api/auth-start': ['./api/auth.js', 'start'],
  '/api/auth-callback': ['./api/auth.js', 'callback'],
  '/api/auth-logout': ['./api/auth.js', 'logout'],
  '/api/me': ['./api/auth.js', 'me'],
  '/api/users': ['./api/auth.js', 'users'],
};

function augmentResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  res.send = (body) => {
    if (body && typeof body === 'object') {
      res.json(body);
      return;
    }
    res.end(String(body ?? ''));
  };
  return res;
}

// Lê o corpo bruto uma vez e devolve tanto o Buffer original (pra quem
// precisa validar assinatura HMAC sobre o texto exato, ex: api/webhook.js)
// quanto a versão já parseada (conveniência pro resto das rotas).
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { raw, parsed: undefined };
  const text = raw.toString('utf8');
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    try {
      return { raw, parsed: JSON.parse(text) };
    } catch {
      return { raw, parsed: text };
    }
  }
  return { raw, parsed: text };
}

const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  augmentResponse(res);

  if (url.pathname === '/api/dev-login') {
    try {
      await handleDevLogin(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error', message: err.message });
    }
    return;
  }

  const route = routes[url.pathname];
  if (route) {
    const [modulePath, action] = route;
    req.query = Object.fromEntries(url.searchParams);
    if (action) req.query.action = action;
    const { raw, parsed } = await readBody(req);
    req.rawBody = raw;
    req.body = parsed;
    try {
      const mod = await import(modulePath);
      await mod.default(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error', message: err.message });
    }
    return;
  }

  // Reflete o middleware.js de produção: sem cookie de sessão, `/` manda pro login.
  if (url.pathname === '/' && !/(?:^|;\s*)softcs_session=/.test(req.headers.cookie || '')) {
    res.writeHead(302, { Location: process.env.DEV_LOGIN_EMAIL ? '/api/dev-login' : '/login.html' });
    res.end();
    return;
  }

  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const data = await readFile(path.join(__dirname, filePath));
    const ext = path.extname(filePath);
    if (STATIC_CONTENT_TYPES[ext]) res.setHeader('Content-Type', STATIC_CONTENT_TYPES[ext]);
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Dev server rodando em http://localhost:${PORT}`);
});
