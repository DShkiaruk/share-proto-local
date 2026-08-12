import { next, rewrite } from '@vercel/edge';
import { sessionFromRequest } from './lib/session.js';

export const config = {
  matcher: ['/((?!api/|login\\.html|favicon\\.svg).*)'],
};

export default async function middleware(req) {
  const session = await sessionFromRequest(
    req.headers.get('cookie') || '',
    process.env.SESSION_SECRET
  );
  if (session) return next();
  return rewrite(new URL('/login.html', req.url));
}
