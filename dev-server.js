// Servidor local simples para testar as functions sem precisar de `vercel login`.
// Roda com: node --env-file=.env dev-server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Alguns caminhos aqui viram a mesma function em produção (vercel.json faz o
// rewrite pra /api/auth?action=... e /api/softcs-oauth?action=...) — o
// segundo elemento simula isso localmente, injetando `action` em req.query
// antes de chamar o handler, sem mudar nenhuma URL externa.
const routes = {
  '/api/webhook': ['./api/webhook.js'],
  '/api/chats': ['./api/chats.js'],
  '/api/agents': ['./api/agents.js'],
  '/api/settings': ['./api/settings.js'],
  '/api/discover-tickets': ['./api/discover-tickets.js'],
  '/api/poll-tickets': ['./api/poll-tickets.js'],
  '/api/telegram-test': ['./api/telegram-test.js'],
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  augmentResponse(res);

  const route = routes[url.pathname];
  if (route) {
    const [modulePath, action] = route;
    req.query = Object.fromEntries(url.searchParams);
    if (action) req.query.action = action;
    req.body = await readJsonBody(req);
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
    res.writeHead(302, { Location: '/login.html' });
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
