/* Hosted comments server on Cloudflare Workers — the embed-mode backend.

   Same API contract as template/server.js / template/api/*, minus the
   prototype-serving parts (an embedded overlay lives on someone else's page;
   this host only serves /overlay.js, /overlay.css and /api/*).

   One Durable Object per comment room (= one per PR preview): a DO is
   single-threaded, which gives the exact same race-free semantics as the
   single-process local server. Threads are stored one-per-key (`t:<id>`), so
   no value ever grows past DO storage limits. */

import { DurableObject } from 'cloudflare:workers';
import { createToken, sessionFromHeaders } from './session.js';

const MAX_TEXT = 3000;
const MAX_NAME = 40;
const NAV_CAP = 500;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const clean = (str, max) => String(str || '').trim().slice(0, max);
const canSee = (role, thread) => role === 'designer' || thread.authorRole === 'client';

/* ---------- CORS (same semantics as template/lib/cors.js) ---------- */

function originAllowed(origin, allowedEnv) {
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

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin || !originAllowed(origin, env.ALLOWED_ORIGINS)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (status, payload, extra = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

/* ---------- the room ---------- */

export class CommentsRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const all = await this.ctx.storage.list();
    this.threads = [];
    this.nav = {};
    for (const [key, value] of all) {
      if (key.startsWith('t:')) this.threads.push(value);
      else if (key === 'nav') this.nav = value;
    }
    this.threads.sort((a, b) => a.createdAt - b.createdAt);
    this.loaded = true;
  }

  async getAll(role) {
    await this.load();
    const nav = {};
    for (const [k, v] of Object.entries(this.nav)) nav[k] = v.anchor;
    return { nav, threads: this.threads.filter((t) => canSee(role, t)) };
  }

  // Returns {status, payload}. Mirrors apiComments() in template/server.js —
  // author identity comes from the signed session, never from the body.
  async mutate(role, author, body) {
    await this.load();
    const action = body.action;
    const now = Date.now();

    if (action === 'edge') {
      const from = clean(body.from, 64);
      const to = clean(body.to, 64);
      const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
      if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
        return { status: 400, payload: { error: 'Bad edge' } };
      }
      this.nav[`${from}>${to}`] = { anchor, at: now };
      const keys = Object.keys(this.nav);
      if (keys.length > NAV_CAP) {
        keys.sort((a, b) => this.nav[a].at - this.nav[b].at);
        while (keys.length > NAV_CAP) delete this.nav[keys.shift()];
      }
      await this.ctx.storage.put('nav', this.nav);
      return { status: 200, payload: { ok: true } };
    }

    if (action === 'create') {
      const text = clean(body.text, MAX_TEXT);
      if (!text) return { status: 400, payload: { error: 'Missing text' } };
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
      await this.ctx.storage.put(`t:${thread.id}`, thread);
      this.threads.push(thread);
      return { status: 200, payload: { thread } };
    }

    const tid = String(body.threadId || '');
    if (!/^[a-f0-9-]{36}$/.test(tid)) return { status: 404, payload: { error: 'Thread not found' } };
    const thread = this.threads.find((t) => t.id === tid);
    if (!thread || !canSee(role, thread)) {
      return { status: 404, payload: { error: 'Thread not found' } };
    }

    if (action === 'reply') {
      const text = clean(body.text, MAX_TEXT);
      if (!text) return { status: 400, payload: { error: 'Missing text' } };
      thread.messages.push({ author, role, text, at: now });
    } else if (action === 'edit') {
      const text = clean(body.text, MAX_TEXT);
      const target = Number(body.at);
      if (!text || !target) return { status: 400, payload: { error: 'Missing text or target' } };
      const msg = thread.messages.find((m) => m.at === target);
      if (!msg || msg.author !== author || msg.role !== role) {
        return { status: 403, payload: { error: 'Not your message' } };
      }
      msg.text = text;
      msg.edited = true;
    } else if (action === 'resolve') {
      thread.resolved = Boolean(body.resolved);
    } else if (action === 'delete') {
      const own = thread.authorRole === role && thread.author === author;
      if (role !== 'designer' && !own) return { status: 403, payload: { error: 'Not allowed' } };
      await this.ctx.storage.delete(`t:${tid}`);
      this.threads = this.threads.filter((t) => t.id !== tid);
      return { status: 200, payload: { ok: true } };
    } else {
      return { status: 400, payload: { error: 'Unknown action' } };
    }

    await this.ctx.storage.put(`t:${tid}`, thread);
    return { status: 200, payload: { thread } };
  }
}

/* ---------- the worker ---------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Overlay assets: public script, served with open CORS so the overlay's
    // cross-origin HEAD version-check works.
    if (url.pathname === '/overlay.js' || url.pathname === '/overlay.css') {
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers);
      h.set('Access-Control-Allow-Origin', '*');
      h.set('Access-Control-Expose-Headers', 'ETag');
      return new Response(r.body, { status: r.status, headers: h });
    }

    if (url.pathname === '/api/login') {
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await req.json().catch(() => ({}));
      const cleanName = clean(body.name, MAX_NAME);
      if (!cleanName) return json(400, { error: 'Missing name' }, cors);
      const password = body.password;
      const role =
        password && password === env.DESIGNER_PASSWORD
          ? 'designer'
          : password && password === env.CLIENT_PASSWORD
            ? 'client'
            : null;
      if (!role) {
        await new Promise((r) => setTimeout(r, 800));
        return json(401, { error: 'Wrong password' }, cors);
      }
      const token = await createToken(
        { r: role, n: cleanName, exp: Date.now() + SIXTY_DAYS_MS },
        env.SESSION_SECRET
      );
      return json(200, { role, token }, cors);
    }

    if (url.pathname === '/api/comments') {
      const session = await sessionFromHeaders(
        req.headers.get('cookie') || '',
        req.headers.get('authorization') || '',
        env.SESSION_SECRET
      );
      if (!session) return json(401, { error: 'Not authenticated' }, cors);
      const role = session.r;
      const author = clean(session.n, MAX_NAME) || (role === 'designer' ? 'Designer' : 'Client');
      const q = (url.searchParams.get('room') || '').toLowerCase();
      const stub = env.ROOM.getByName(ROOM_RE.test(q) ? q : '_');

      if (req.method === 'GET') {
        const data = await stub.getAll(role);
        return json(200, { role, name: author, ...data }, cors);
      }
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await req.json().catch(() => ({}));
      const { status, payload } = await stub.mutate(role, author, body);
      return json(status, payload, cors);
    }

    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' }, cors);
    return env.ASSETS.fetch(req);
  },
};
