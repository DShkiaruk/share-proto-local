/* CORS for embed mode. ALLOWED_ORIGINS: comma-separated origins, `*` inside
   an entry matches one hostname label run (e.g. https://pr-*.preview.acme.com).
   No entry matched → no CORS headers → the browser blocks the call. Tokens
   travel in the Authorization header (not cookies), so no
   Access-Control-Allow-Credentials is ever needed. */

export function originAllowed(origin, allowedEnv) {
  if (!origin) return false;
  for (const raw of String(allowedEnv || '').split(',')) {
    const pat = raw.trim().toLowerCase().replace(/\/+$/, '');
    if (!pat) continue;
    const o = origin.toLowerCase();
    if (pat === o) return true;
    if (pat.includes('*')) {
      const re = new RegExp(
        '^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+') + '$'
      );
      if (re.test(o)) return true;
    }
  }
  return false;
}

// Returns true when the request was an OPTIONS preflight (already answered).
export function applyCors(req, res, allowedEnv) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin, allowedEnv)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

export const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Room = comment partition (one per PR preview). Invalid/absent → '' (classic).
export function roomFromReq(req) {
  const q = new URL(req.url, 'http://x').searchParams.get('room') || '';
  const room = q.toLowerCase();
  return ROOM_RE.test(room) ? room : '';
}
