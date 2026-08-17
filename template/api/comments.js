import { list, put, del } from '@vercel/blob';
import { sessionFromHeaders } from '../lib/session.js';
import { applyCors, roomFromReq } from '../lib/cors.js';

/* Storage model: append-only. Every mutation writes a NEW blob with a unique
   pathname (never overwrites), because the Blob CDN caches overwritten
   pathnames for up to a minute and would serve stale threads. A per-mutation
   snapshot blob makes reads cheap: GET = 1 list + 1 fetch.

   threads/<tid>/<ts>-<uuid>.json  → {type:'msg', ...} (creation msg carries thread meta in `first`)
   threads/<tid>/<ts>-<uuid>.json  → {type:'state', resolved}
   threads/<tid>/<ts>-<uuid>.json  → {type:'tomb'}
   snap/<invTs>-<uuid>.json        → full reconstructed thread array (newest sorts first) */

const MAX_TEXT = 3000;
const MAX_NAME = 40;
const PAD = 14;

const clean = (str, max) => String(str || '').trim().slice(0, max);
const ts = (at) => String(at).padStart(PAD, '0');
const invTs = (at) => String(10 ** PAD - at).padStart(PAD, '0');
const canSee = (role, thread) => role === 'designer' || thread.authorRole === 'client';

async function listAll(prefix) {
  const blobs = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const page = await list({ prefix, limit: 1000, cursor });
    blobs.push(...page.blobs);
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  return blobs;
}

async function fetchJson(blob) {
  try {
    const r = await fetch(blob.url, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function writeEvent(root, tid, at, payload) {
  return put(
    `${root}threads/${tid}/${ts(at)}-${crypto.randomUUID()}.json`,
    JSON.stringify(payload),
    { access: 'public', addRandomSuffix: false, contentType: 'application/json' }
  );
}

function assemble(events, root) {
  // events: [{pathname, data}] for one or many threads
  const byThread = new Map();
  for (const { pathname, data } of events) {
    if (!data) continue;
    // Rooms nest everything under rooms/<room>/ — strip before parsing.
    const rel = root && pathname.startsWith(root) ? pathname.slice(root.length) : pathname;
    const parts = rel.split('/');
    if (parts.length !== 3) continue; // ignore legacy/foreign blobs
    const tid = parts[1];
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push({ pathname, data });
  }
  const threads = [];
  for (const [tid, evs] of byThread) {
    evs.sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
    if (evs.some((e) => e.data.type === 'tomb')) continue;
    const msgs = evs.filter((e) => e.data.type === 'msg').map((e) => e.data);
    const firstMsg = msgs.find((m) => m.first);
    if (!firstMsg) continue;
    const states = evs.filter((e) => e.data.type === 'state');
    const messages = msgs.map((m) => ({ author: m.author, role: m.role, text: m.text, at: m.at }));
    for (const e of evs.filter((x) => x.data.type === 'edit')) {
      const m = messages.find((x) => x.at === e.data.target);
      if (m) {
        m.text = e.data.text;
        m.edited = true;
      }
    }
    threads.push({
      id: tid,
      createdAt: firstMsg.at,
      authorRole: firstMsg.first.authorRole,
      author: firstMsg.author,
      screen: firstMsg.first.screen,
      screenLabel: firstMsg.first.screenLabel,
      anchor: firstMsg.first.anchor,
      proto: firstMsg.first.proto || null,
      page: firstMsg.first.page || null,
      resolved: states.length ? Boolean(states.at(-1).resolved) : false,
      messages,
    });
  }
  threads.sort((a, b) => a.createdAt - b.createdAt);
  return threads;
}

async function reconstruct(root, prefix) {
  const blobs = await listAll(prefix);
  const events = await Promise.all(
    blobs.map(async (b) => ({ pathname: b.pathname, data: await fetchJson(b) }))
  );
  return assemble(events, root);
}

async function loadSnapshot(root) {
  const { blobs } = await list({ prefix: `${root}snap/`, limit: 1 });
  if (!blobs.length) return null;
  return fetchJson(blobs[0]);
}

async function writeSnapshot(root, threads, at) {
  await put(`${root}snap/${invTs(at)}-${crypto.randomUUID()}.json`, JSON.stringify(threads), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  // GC: keep the 5 newest snapshots
  const { blobs } = await list({ prefix: `${root}snap/`, limit: 100 });
  const stale = blobs.slice(5);
  if (stale.length) await del(stale.map((b) => b.url)).catch(() => {});
}

/* ---- shared navigation graph (learned prototype transitions) ---- */

const NAV_CAP = 500;

async function loadNavSnap(root) {
  const { blobs } = await list({ prefix: `${root}navsnap/`, limit: 1 });
  if (!blobs.length) return {};
  return (await fetchJson(blobs[0])) || {};
}

async function rebuildNavSnap(root, at) {
  const blobs = await listAll(`${root}nav/`);
  const edges = (await Promise.all(blobs.map(fetchJson))).filter(Boolean);
  edges.sort((a, b) => a.at - b.at);
  const map = {};
  for (const e of edges) map[`${e.from}>${e.to}`] = { anchor: e.anchor, at: e.at };
  const keys = Object.keys(map).sort((a, b) => map[a].at - map[b].at);
  while (keys.length > NAV_CAP) delete map[keys.shift()];
  await put(`${root}navsnap/${invTs(at)}-${crypto.randomUUID()}.json`, JSON.stringify(map), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  const snaps = await list({ prefix: `${root}navsnap/`, limit: 100 });
  const stale = snaps.blobs.slice(3);
  if (stale.length) await del(stale.map((b) => b.url)).catch(() => {});
}

async function snapshotAll(root, at, patch) {
  // Full rebuild from raw events, then force-apply the mutation we just
  // wrote: list() can lag a freshly-put blob by a moment, and the caller's
  // own write must be reflected in the snapshot it produces.
  let threads = await reconstruct(root, `${root}threads/`);
  if (patch) threads = patch(threads);
  threads.sort((a, b) => a.createdAt - b.createdAt);
  await writeSnapshot(root, threads, at);
  return threads;
}

export default async function handler(req, res) {
  if (applyCors(req, res, process.env.ALLOWED_ORIGINS)) return;
  const session = await sessionFromHeaders(
    req.headers.cookie || '',
    req.headers.authorization || '',
    process.env.SESSION_SECRET
  );
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  // Room = one comment partition per PR preview (empty for classic installs).
  const room = roomFromReq(req);
  const root = room ? `rooms/${room}/` : '';
  const role = session.r;
  // Author identity comes from the signed session (set at login), never from
  // the request body — client sees only client threads, so authorship must be
  // trustworthy.
  const author =
    clean(session.n, MAX_NAME) || (role === 'designer' ? 'Designer' : 'Client');

  if (req.method === 'GET') {
    const [threads, navRaw] = await Promise.all([
      loadSnapshot(root).then((s) => s ?? reconstruct(root, `${root}threads/`)),
      loadNavSnap(root),
    ]);
    const nav = {};
    for (const [k, v] of Object.entries(navRaw)) nav[k] = v.anchor;
    return res
      .status(200)
      .json({ role, name: author, nav, threads: threads.filter((t) => canSee(role, t)) });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = body.action;
  const now = Date.now();

  if (action === 'edge') {
    const from = clean(body.from, 64);
    const to = clean(body.to, 64);
    const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
    if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
      return res.status(400).json({ error: 'Bad edge' });
    }
    await put(
      `${root}nav/e-${ts(now)}-${crypto.randomUUID()}.json`,
      JSON.stringify({ from, to, anchor, at: now }),
      { access: 'public', addRandomSuffix: false, contentType: 'application/json' }
    );
    await rebuildNavSnap(root, now);
    return res.status(200).json({ ok: true });
  }

  if (action === 'create') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const tid = crypto.randomUUID();
    const fullThread = {
      id: tid,
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
    await writeEvent(root, tid, now, {
      type: 'msg',
      at: now,
      author,
      role,
      text,
      first: {
        authorRole: fullThread.authorRole,
        screen: fullThread.screen,
        screenLabel: fullThread.screenLabel,
        anchor: fullThread.anchor,
        proto: fullThread.proto,
        page: fullThread.page,
      },
    });
    const threads = await snapshotAll(root, now, (all) =>
      all.some((t) => t.id === tid) ? all : [...all, fullThread]
    );
    const thread = threads.find((t) => t.id === tid);
    return res.status(200).json({ thread });
  }

  const tid = String(body.threadId || '');
  if (!/^[a-f0-9-]{36}$/.test(tid)) return res.status(404).json({ error: 'Thread not found' });
  const [existing] = await reconstruct(root, `${root}threads/${tid}/`);
  if (!existing || !canSee(role, existing)) {
    return res.status(404).json({ error: 'Thread not found' });
  }

  let patch;
  if (action === 'reply') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const msg = { author, role, text, at: now };
    await writeEvent(root, tid, now, { type: 'msg', ...msg });
    patch = (all) =>
      all.map((t) =>
        t.id === tid && !t.messages.some((m) => m.at === now && m.author === author)
          ? { ...t, messages: [...t.messages, msg] }
          : t
      );
  } else if (action === 'edit') {
    const text = clean(body.text, MAX_TEXT);
    const target = Number(body.at);
    if (!text || !target) return res.status(400).json({ error: 'Missing text or target' });
    const msg = existing.messages.find((m) => m.at === target);
    if (!msg || msg.author !== author || msg.role !== role) {
      return res.status(403).json({ error: 'Not your message' });
    }
    await writeEvent(root, tid, now, { type: 'edit', at: now, target, text });
    patch = (all) =>
      all.map((t) =>
        t.id === tid
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.at === target ? { ...m, text, edited: true } : m
              ),
            }
          : t
      );
  } else if (action === 'resolve') {
    const resolved = Boolean(body.resolved);
    await writeEvent(root, tid, now, { type: 'state', at: now, resolved });
    patch = (all) => all.map((t) => (t.id === tid ? { ...t, resolved } : t));
  } else if (action === 'delete') {
    const own = existing.authorRole === role && existing.author === author;
    if (role !== 'designer' && !own) return res.status(403).json({ error: 'Not allowed' });
    await writeEvent(root, tid, now, { type: 'tomb', at: now });
    const old = await listAll(`${root}threads/${tid}/`);
    const gone = old.filter((b) => !b.pathname.includes(ts(now)));
    if (gone.length) await del(gone.map((b) => b.url)).catch(() => {});
    patch = (all) => all.filter((t) => t.id !== tid);
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  const threads = await snapshotAll(root, now, patch);
  if (action === 'delete') return res.status(200).json({ ok: true });
  return res.status(200).json({ thread: threads.find((t) => t.id === tid) });
}
