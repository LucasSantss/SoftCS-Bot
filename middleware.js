// Edge Middleware: bloqueia o carregamento do painel (`/`) sem cookie de
// sessão, mandando pra tela de login. É só uma camada de UX — a validação
// de verdade (sessão existe no banco, e-mail continua na allowlist) acontece
// em cada endpoint de /api/* via lib/auth.js, então isso aqui não é um jeito
// de burlar a proteção real mesmo se alguém forjar o cookie.
export const config = { matcher: ['/', '/index.html'] };

export default function middleware(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const hasSession = /(?:^|;\s*)softcs_session=/.test(cookieHeader);
  if (!hasSession) {
    return Response.redirect(new URL('/login.html', request.url));
  }
}
