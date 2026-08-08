// Servidor local simples para testar as functions sem precisar de `vercel login`.
// Roda com: node --env-file=.env dev-server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const routes = {
  '/api/webhook': () => import('./api/webhook.js'),
  '/api/chats': () => import('./api/chats.js'),
  '/api/agents': () => import('./api/agents.js'),
  '/api/settings': () => import('./api/settings.js'),
  '/api/oauth-start': () => import('./api/oauth-start.js'),
  '/api/oauth-callback': () => import('./api/oauth-callback.js'),
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

const STATIC_CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  augmentResponse(res);

  const loadRoute = routes[url.pathname];
  if (loadRoute) {
    req.query = Object.fromEntries(url.searchParams);
    req.body = await readJsonBody(req);
    try {
      const mod = await loadRoute();
      await mod.default(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error', message: err.message });
    }
    return;
  }

  const filePath = url.pathname === '/' ? '/admin.html' : url.pathname;
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
