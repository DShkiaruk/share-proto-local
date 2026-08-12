#!/usr/bin/env node
/* Local share-proto server — the no-Vercel mode.

   Same contracts as the deployed version (middleware.js + api/*): password
   login with two roles, signed session cookie, /api/comments with
   server-enforced role filtering. But self-contained: plain Node >= 18,
   zero npm dependencies, comments stored in data/comments.json.

   The append-only event log in api/comments.js exists only to dodge Vercel
   Blob's CDN cache; locally there is no CDN, so a single JSON file written
   atomically (tmp + rename) is the honest equivalent.

   Usage:
     node server.js [--port 3456] [--spa]

   --spa serves index.html for extension-less paths that don't exist on disk
   (client-side routing in app builds).

   Share beyond localhost (link dies with the process):
     cloudflared tunnel --url http://localhost:3456 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18

const { createToken, sessionFromRequest } = await import('./lib/session.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const COMMENTS_FILE = path.join(DATA, 'comments.json');

const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = Number(
  (portFlag >= 0 && argv[portFlag + 1]) || process.env.PORT || 3456
);
const SPA = argv.includes('--spa');

const MAX_TEXT = 3000;
const MAX_NAME = 40;
const NAV_CAP = 500;
const SIXTY_DAYS_S = 60 * 24 * 60 * 60;

const clean = (str, max) => String(str || '').trim().slice(0, max);
const canSee = (role, thread) => role === 'designer' || thread.authorRole === 'client';

/* ---------- secrets: generated on first run, env vars override ---------- */

fs.mkdirSync(DATA, { recursive: true });

function loadSecrets() {
  const file = path.join(DATA, 'secrets.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  const base = path.basename(ROOT).replace(/-share$/, '') || 'proto';
  const secrets = {
    designerPassword:
      process.env.DESIGNER_PASSWORD ||
      saved.designerPassword ||
      `${base}-team-${randomBytes(2).toString('hex')}`,
    clientPassword:
      process.env.CLIENT_PASSWORD ||
      saved.clientPassword ||
      `${base}-client-${randomBytes(2).toString('hex')}`,
    sessionSecret:
      process.env.SESSION_SECRET || saved.sessionSecret || randomBytes(32).toString('hex'),
  };
  // Persist so passwords and sessions survive restarts.
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2) + '\n');
  return secrets;
}

const SECRETS = loadSecrets();

/* ---------- storage: in-memory, atomic JSON persistence ---------- */

let store = { threads: [], nav: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8'));
  store.threads = Array.isArray(loaded.threads) ? loaded.threads : [];
  store.nav = loaded.nav && typeof loaded.nav === 'object' ? loaded.nav : {};
} catch {
  /* first run */
}

let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain
    .then(async () => {
      const tmp = path.join(DATA, `.comments-${process.pid}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(store, null, 1));
      await fsp.rename(tmp, COMMENTS_FILE);
    })
    .catch((e) => console.error('persist failed:', e.message));
  return writeChain;
}

/* ---------- helpers ---------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function setSessionCookie(req, res, token, maxAge) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const secure = proto.includes('https') ? ' Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `fp_session=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`
  );
}

/* ---------- api handlers (contracts mirror api/*.js) ---------- */

async function apiLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const body = (await readBody(req)) || {};
  const cleanName = clean(body.name, MAX_NAME);
  if (!cleanName) return json(res, 400, { error: 'Missing name' });
  const password = body.password;
  const role =
    password && password === SECRETS.designerPassword
      ? 'designer'
      : password && password === SECRETS.clientPassword
        ? 'client'
        : null;
  if (!role) {
    await new Promise((r) => setTimeout(r, 800));
    return json(res, 401, { error: 'Wrong password' });
  }
  const token = await createToken(
    { r: role, n: cleanName, exp: Date.now() + SIXTY_DAYS_S * 1000 },
    SECRETS.sessionSecret
  );
  setSessionCookie(req, res, token, SIXTY_DAYS_S);
  return json(res, 200, { role });
}

function apiLogout(req, res) {
  setSessionCookie(req, res, '', 0);
  res.writeHead(302, { Location: '/' });
  res.end();
}

async function apiComments(req, res, session) {
  const role = session.r;
  // Author identity comes from the signed session, never from the body —
  // role filtering is only as trustworthy as authorship (same as api/comments.js).
  const author = clean(session.n, MAX_NAME) || (role === 'designer' ? 'Designer' : 'Client');

  if (req.method === 'GET') {
    const nav = {};
    for (const [k, v] of Object.entries(store.nav)) nav[k] = v.anchor;
    return json(res, 200, {
      role,
      name: author,
      nav,
      threads: store.threads.filter((t) => canSee(role, t)),
    });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = (await readBody(req)) || {};
  const action = body.action;
  const now = Date.now();

  if (action === 'edge') {
    const from = clean(body.from, 64);
    const to = clean(body.to, 64);
    const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
    if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
      return json(res, 400, { error: 'Bad edge' });
    }
    store.nav[`${from}>${to}`] = { anchor, at: now };
    const keys = Object.keys(store.nav);
    if (keys.length > NAV_CAP) {
      keys.sort((a, b) => store.nav[a].at - store.nav[b].at);
      while (keys.length > NAV_CAP) delete store.nav[keys.shift()];
    }
    await persist();
    return json(res, 200, { ok: true });
  }

  if (action === 'create') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return json(res, 400, { error: 'Missing text' });
    const thread = {
      id: crypto.randomUUID(),
      createdAt: now,
      authorRole: role,
      author,
      screen: clean(body.screen, 64),
      screenLabel: clean(body.screenLabel, 120),
      anchor: body.anchor && typeof body.anchor === 'object' ? body.anchor : null,
      proto: clean(body.proto, 64) || null,
      page: clean(body.page, 200) || null,
      resolved: false,
      messages: [{ author, role, text, at: now }],
    };
    store.threads.push(thread);
    await persist();
    return json(res, 200, { thread });
  }

  const tid = String(body.threadId || '');
  if (!/^[a-f0-9-]{36}$/.test(tid)) return json(res, 404, { error: 'Thread not found' });
  const thread = store.threads.find((t) => t.id === tid);
  if (!thread || !canSee(role, thread)) {
    return json(res, 404, { error: 'Thread not found' });
  }

  if (action === 'reply') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return json(res, 400, { error: 'Missing text' });
    thread.messages.push({ author, role, text, at: now });
  } else if (action === 'edit') {
    const text = clean(body.text, MAX_TEXT);
    const target = Number(body.at);
    if (!text || !target) return json(res, 400, { error: 'Missing text or target' });
    const msg = thread.messages.find((m) => m.at === target);
    if (!msg || msg.author !== author || msg.role !== role) {
      return json(res, 403, { error: 'Not your message' });
    }
    msg.text = text;
    msg.edited = true;
  } else if (action === 'resolve') {
    thread.resolved = Boolean(body.resolved);
  } else if (action === 'delete') {
    const own = thread.authorRole === role && thread.author === author;
    if (role !== 'designer' && !own) return json(res, 403, { error: 'Not allowed' });
    store.threads = store.threads.filter((t) => t.id !== tid);
    await persist();
    return json(res, 200, { ok: true });
  } else {
    return json(res, 400, { error: 'Unknown action' });
  }

  await persist();
  return json(res, 200, { thread });
}

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

function resolveFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  let file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return null; // traversal
  let st = fs.statSync(file, { throwIfNoEntry: false });
  if (st?.isDirectory()) {
    file = path.join(file, 'index.html');
    st = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!st && SPA && !path.extname(rel)) {
    file = path.join(PUBLIC, 'index.html');
    st = fs.statSync(file, { throwIfNoEntry: false });
  }
  return st?.isFile() ? { file, st } : null;
}

function sendFile(req, res, file, st, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Reviews iterate fast; correctness beats caching. ETag keeps it cheap.
    'Cache-Control': isHtml ? 'no-store' : 'no-cache',
    ETag: etag,
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = st.size;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- server ---------- */

const OPEN_PATHS = new Set(['/login.html', '/favicon.svg']);

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://local').pathname;

    if (pathname === '/api/login') return await apiLogin(req, res);
    if (pathname === '/api/logout') return apiLogout(req, res);

    const session = await sessionFromRequest(req.headers.cookie || '', SECRETS.sessionSecret);

    if (pathname === '/api/comments') {
      if (!session) return json(res, 401, { error: 'Not authenticated' });
      return await apiComments(req, res, session);
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    if (!session && !OPEN_PATHS.has(pathname)) {
      // Same behavior as middleware.js: rewrite (not redirect) to the login
      // page so deep links like /?comment=<id> survive the login round-trip.
      const login = resolveFile('/login.html');
      if (!login) return json(res, 500, { error: 'login.html missing' });
      return sendFile(req, res, login.file, login.st);
    }

    const hit = resolveFile(pathname);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    return sendFile(req, res, hit.file, hit.st);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`
  share-proto local server ${SPA ? '(SPA mode)' : ''}

  Local URL:        http://localhost:${PORT}
  Team password:    ${SECRETS.designerPassword}
  Client password:  ${SECRETS.clientPassword}

  Comments live in  data/comments.json  (delete the file to wipe)
  Share online:     cloudflared tunnel --url http://localhost:${PORT}
                    (temporary link; dies when you stop the process)
`);
});
