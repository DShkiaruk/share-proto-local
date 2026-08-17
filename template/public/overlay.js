/* proto-share comment overlay — pins, threads, role-based visibility.
   Runs in a shadow root so prototype styles and overlay styles never collide. */
(() => {
  'use strict';

  const PASTELS = ['#dbffd5', '#d5edff', '#ffd4b1', '#f4d5ff', '#fff3c4', '#ffd5d5'];
  const POLL_MS = 25000;

  /* ---------- embed mode ----------
     When this script is served from a different origin than the page it runs
     on (e.g. dropped into a client's PR preview), the page has no share-proto
     server of its own: API and asset URLs point at the script's origin, auth
     is a Bearer token (cross-site cookies don't survive), login happens in an
     in-overlay modal, and comments are partitioned into a room derived from
     the preview hostname (pr-N.<domain> → room "pr-n"). Same-origin installs
     behave exactly as before. */
  const SCRIPT_EL = document.currentScript;
  const API_ORIGIN = (() => {
    try {
      return new URL(SCRIPT_EL.src).origin;
    } catch {
      return location.origin;
    }
  })();
  // data-embed forces embed mode on a same-origin page (the host's own /demo);
  // data-room pins the comment room instead of deriving it from the hostname.
  const EMBED =
    API_ORIGIN !== location.origin || Boolean(SCRIPT_EL && SCRIPT_EL.hasAttribute('data-embed'));
  const ROOM = EMBED
    ? (SCRIPT_EL && SCRIPT_EL.getAttribute('data-room')) ||
      (location.hostname.toLowerCase().match(/^(pr-\d+)\./) || [])[1] ||
      location.hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
    : null;
  const TOKEN_KEY = `fp_token::${API_ORIGIN}`;
  let authToken = EMBED ? localStorage.getItem(TOKEN_KEY) : null;
  const apiUrl = (path) =>
    (EMBED ? API_ORIGIN : '') + path + (ROOM ? `?room=${encodeURIComponent(ROOM)}` : '');
  const authHeaders = () =>
    EMBED && authToken ? { Authorization: `Bearer ${authToken}` } : {};

  // Exact Lucide icon paths (lucide.dev, ISC) — stroke 2, viewBox 24.
  const svg = (inner) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ICONS = {
    comment: svg(
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>'
    ),
    threads: svg(
      '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>'
    ),
    check: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
    trash: svg(
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
    ),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
    eye: svg(
      '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
    ),
    eyeOff: svg(
      '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'
    ),
    goto: svg('<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>'),
    link: svg(
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
    ),
    edit: svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
    grip: svg(
      '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>'
    ),
  };

  const state = {
    role: null,
    name: '',
    proto: '', // current prototype version (hash of served index.html)
    nav: {}, // shared navigation graph from the server
    threads: [],
    screen: '',
    screenLabel: '',
    mode: false,
    sidebar: false,
    pinsHidden: localStorage.getItem('fp_pins_hidden') === '1',
    filter: 'open',
    draft: null, // {x, y, anchor}
    active: null, // open thread id
    pendingJump: null, // thread id we're guiding the user to
    confirmDelete: null,
  };

  const roleLabel = () => (state.role === 'designer' ? 'Designer' : 'Client');
  // Identity comes from login (name + password) via the signed session;
  // the server stamps every comment with it.
  const myLabel = () => state.name || roleLabel();

  /* ---------- DOM helpers ---------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(name) {
    const s = el('span');
    s.innerHTML = ICONS[name];
    s.style.display = 'contents';
    return s;
  }

  function pastel(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PASTELS[h % PASTELS.length];
  }

  function avatar(name, size) {
    const a = el('span', `avatar s${size}`, (name || '?').trim().charAt(0).toUpperCase());
    a.style.background = pastel(name || '?');
    return a;
  }

  /* ---------- unread state (per browser, shown as blue dots) ---------- */

  function readMap() {
    try {
      return JSON.parse(localStorage.getItem('fp_read') || '{}');
    } catch {
      return {};
    }
  }

  function lastAt(t) {
    return t.messages.at(-1)?.at || t.createdAt;
  }

  function isUnread(t) {
    const last = t.messages.at(-1);
    if (!last) return false;
    if (last.author === myLabel() && last.role === state.role) return false;
    return (readMap()[t.id] || 0) < last.at;
  }

  function markRead(threads) {
    const m = readMap();
    for (const t of threads) m[t.id] = lastAt(t);
    localStorage.setItem('fp_read', JSON.stringify(m));
  }

  // When someone sets a display name, keep their role visible via a badge.
  function roleBadge(t) {
    if (t.authorRole === 'client' && t.author !== 'Client') return 'Client';
    if (t.authorRole === 'designer' && t.author !== 'Designer') return 'Team';
    return null;
  }

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* ---------- shadow root ---------- */

  const host = el('div');
  host.setAttribute('data-fp-host', '');
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = (EMBED ? API_ORIGIN : '') + '/overlay.css';
  shadow.appendChild(link);
  const root = el('div', 'root');
  shadow.appendChild(root);

  const clickLayer = el('div', 'click-layer');
  clickLayer.hidden = true;
  const pinsLayer = el('div', 'pins');
  const toolbar = el('div', 'toolbar');
  const sidebar = el('aside', 'sidebar');
  let popover = null;

  root.append(clickLayer, pinsLayer, toolbar, sidebar);
  document.body.appendChild(host);

  /* ---------- screen fingerprint ---------- */

  function appRoot() {
    return (
      document.getElementById('root') ||
      document.querySelector('body > div:not([data-fp-host])') ||
      document.body
    );
  }

  // Screen identity = the page's heading (its label), NOT a content hash.
  // Content hashes made the same page with different data look like different
  // screens (breaking shared navigation), and a comment belongs to its PAGE:
  // "All Documents" is "All Documents" for everyone, whatever rows it shows.

  // Auto-match the prototype's theme: sample the effective background and
  // flip the overlay to dark tokens when the prototype is dark.
  function detectTheme() {
    let node = appRoot();
    let bg = null;
    while (node && node !== document.documentElement.parentNode) {
      const b = getComputedStyle(node).backgroundColor;
      if (b && b !== 'transparent' && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(b)) {
        bg = b;
        break;
      }
      node = node.parentElement;
    }
    if (!bg) return;
    const m = bg.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
    if (!m) return;
    const lum = 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3];
    root.classList.toggle('dark', lum < 128);
  }

  function screenLabel() {
    // Composite of the first two distinct headings: single-page apps often
    // keep one constant h1 across tabs — the second heading tells tabs apart.
    const parts = [];
    for (const hd of appRoot().querySelectorAll('h1, h2, h3')) {
      const t = (hd.innerText || '').trim().slice(0, 40);
      if (t && hd.getClientRects().length && !parts.includes(t)) {
        parts.push(t);
        if (parts.length === 2) break;
      }
    }
    return parts.join(' · ') || document.title || 'Screen';
  }

  /* ---------- anchors ---------- */

  function buildPath(target) {
    const segs = [];
    let n = target;
    let depth = 0;
    while (n && n !== document.body && n.nodeType === 1 && depth < 14) {
      const tag = n.tagName.toLowerCase();
      if (n.id) {
        segs.unshift(`${tag}[id="${n.id.replace(/"/g, '')}"]`);
        return segs.join(' > ');
      }
      let i = 1;
      let sib = n.previousElementSibling;
      while (sib) {
        if (sib.tagName === n.tagName) i++;
        sib = sib.previousElementSibling;
      }
      segs.unshift(`${tag}:nth-of-type(${i})`);
      n = n.parentElement;
      depth++;
    }
    return 'body > ' + segs.join(' > ');
  }

  function buildAnchor(x, y) {
    const target =
      document.elementsFromPoint(x, y).find((e) => e !== host && !host.contains(e)) ||
      document.body;
    const rect = target.getBoundingClientRect();
    const de = document.documentElement;
    // Short own text doubles as a cross-breakpoint re-anchor hint: the nth-of-type
    // path can shift when responsive layouts render different surrounding DOM.
    const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      path: buildPath(target),
      t: target.tagName.toLowerCase(),
      txt: s && s.length <= 60 ? s : null,
      ox: rect.width ? (x - rect.left) / rect.width : 0.5,
      oy: rect.height ? (y - rect.top) / rect.height : 0.5,
      fx: de.scrollWidth ? (x + window.scrollX) / de.scrollWidth : 0.5,
      fy: de.scrollHeight ? (y + window.scrollY) / de.scrollHeight : 0.5,
    };
  }

  function posInside(target, anchor) {
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) return null; // exists but hidden
    return { x: r.left + (anchor.ox ?? 0.5) * r.width, y: r.top + (anchor.oy ?? 0.5) * r.height };
  }

  // A pin is visible wherever its anchored element actually exists and is
  // rendered — the prototype mounts/unmounts screens, so this is the screen
  // check. pos is null when the anchor isn't on the current screen.
  function locateAnchor(anchor) {
    if (!anchor) return { el: null, pos: null };
    if (anchor.path) {
      let target = null;
      try {
        target = document.querySelector(anchor.path);
      } catch {
        target = null;
      }
      // nth-of-type paths can resolve to a *different* element on another
      // screen with similar structure — verify against the text hint.
      if (target && anchor.txt) {
        const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
        if (s !== anchor.txt) target = null;
      }
      if (target) return { el: target, pos: posInside(target, anchor) };
      // Path failed (responsive layouts shift nth-of-type chains): re-anchor
      // by exact tag + text, only when the match is unambiguous.
      if (anchor.txt && anchor.t) {
        const matches = [...document.querySelectorAll(anchor.t)].filter(
          (e) =>
            !host.contains(e) &&
            e !== host &&
            (e.textContent || '').replace(/\s+/g, ' ').trim() === anchor.txt &&
            e.getClientRects().length
        );
        if (matches.length === 1) return { el: matches[0], pos: posInside(matches[0], anchor) };
      }
      return { el: null, pos: null };
    }
    return { el: null, pos: fracPos(anchor) };
  }

  // Approximate position from stored document fractions — used when the
  // anchor element is gone but the comment still belongs to this page.
  function fracPos(anchor) {
    if (!anchor) return null;
    const de = document.documentElement;
    return {
      x: (anchor.fx ?? 0.5) * de.scrollWidth - window.scrollX,
      y: (anchor.fy ?? 0.5) * de.scrollHeight - window.scrollY,
    };
  }

  const resolveAnchor = (anchor) => locateAnchor(anchor).pos;

  // Older builds used a single-heading label; newer ones join two ("A · B").
  // A legacy label equals the first part of its composite successor.
  function labelsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.split(' · ')[0] === b || b.split(' · ')[0] === a;
  }

  // A comment lives on the PAGE it was left on.
  // Page check first: on multi-page prototypes two pages can share headings,
  // and a label match alone would render the pin on the wrong page.
  const onThisScreen = (t) =>
    (!t.page || t.page === location.pathname) &&
    (!t.screenLabel || labelsMatch(t.screenLabel, state.screen));

  /* ---------- api ---------- */

  async function api(method, body) {
    const r = await fetch(apiUrl('/api/comments'), {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      if (EMBED) {
        // Token missing/expired: ask for credentials in place — the host page
        // is the client's preview, there is no login page to bounce to.
        authToken = null;
        localStorage.removeItem(TOKEN_KEY);
        showLogin();
      } else {
        location.reload(); // same-origin: the server gate shows login.html
      }
      throw new Error('unauthenticated');
    }
    if (!r.ok) throw new Error(`api ${r.status}`);
    return r.json();
  }

  /* ---------- embed login modal ---------- */

  let loginCard = null;
  function showLogin() {
    if (loginCard) return;
    setMode(false);
    toolbar.style.display = 'none';
    loginCard = el('div', 'login-wrap');
    const card = el('div', 'login-card');
    card.appendChild(el('div', 'login-title', 'Design review comments'));
    card.appendChild(
      el('div', 'login-sub', 'Enter your name and the password you received — comments you leave will be signed with your name.')
    );
    const nameIn = el('input', 'login-input');
    nameIn.placeholder = 'Your name';
    nameIn.value = localStorage.getItem('fp_name') || '';
    const passIn = el('input', 'login-input');
    passIn.placeholder = 'Password';
    passIn.type = 'password';
    const err = el('div', 'login-err');
    const btn = el('button', 'login-btn', 'Continue');
    const submit = async () => {
      const name = nameIn.value.trim();
      const password = passIn.value.trim();
      if (!name) return err.replaceChildren('Please enter your name.');
      if (!password) return err.replaceChildren('Please enter the password.');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await fetch(API_ORIGIN + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password }),
        });
        if (!r.ok) {
          err.replaceChildren('That password didn’t work.');
          passIn.select();
          return;
        }
        const data = await r.json();
        if (!data.token) {
          err.replaceChildren('Server is too old for embed mode.');
          return;
        }
        authToken = data.token;
        localStorage.setItem(TOKEN_KEY, authToken);
        localStorage.setItem('fp_name', name);
        loginCard.remove();
        loginCard = null;
        toolbar.style.display = '';
        refresh();
      } catch {
        err.replaceChildren('Network error — try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Continue';
      }
    };
    btn.addEventListener('click', submit);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    card.append(nameIn, passIn, err, btn);
    loginCard.appendChild(card);
    root.appendChild(loginCard);
    (nameIn.value ? passIn : nameIn).focus();
  }

  let inflight = null;
  function refresh() {
    if (!inflight) {
      inflight = (async () => {
        try {
          const data = await api('GET');
          state.role = data.role;
          state.name = data.name || '';
          state.nav = data.nav || {};
          state.threads = data.threads;
          renderAll();
          // Live-update an open thread when new replies arrive — unless the
          // viewer is mid-typing a reply.
          if (popover && state.active) {
            const t = state.threads.find((x) => x.id === state.active);
            const p = pinEls.get(state.active);
            const shown = popover.querySelectorAll('.msg').length;
            const ta = popover.querySelector('.compose textarea');
            if (t && p && shown && t.messages.length !== shown && (!ta || !ta.value.trim())) {
              openThread(t.id, p);
            }
          }
        } catch {
          /* transient network errors: keep current state */
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  }

  /* ---------- toast ---------- */

  let toastTimer = null;
  function toast(text, ms = 3000) {
    shadow.querySelectorAll('.toast:not(.sticky)').forEach((t) => t.remove());
    const t = el('div', 'toast', text);
    if (stickyEl) t.style.bottom = '124px'; // don't cover the sticky guide
    root.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
  }

  let stickyEl = null;
  function toastSticky(text) {
    clearSticky();
    stickyEl = el('div', 'toast sticky', text);
    root.appendChild(stickyEl);
  }
  function clearSticky() {
    stickyEl?.remove();
    stickyEl = null;
  }

  /* ---------- toolbar ---------- */

  const btnMode = el('button', 'tb-btn');
  btnMode.append(icon('comment'), el('span', 'tb-label', 'Comment'), Object.assign(el('kbd'), { textContent: 'C' }));
  btnMode.setAttribute('aria-label', 'Comment mode');
  btnMode.addEventListener('click', () => setMode(!state.mode));

  const btnThreads = el('button', 'tb-btn');
  const countBadge = el('span', 'count');
  btnThreads.append(icon('threads'), el('span', 'tb-label', 'Threads'), countBadge);
  btnThreads.setAttribute('aria-label', 'Comment threads');
  btnThreads.addEventListener('click', () => setSidebar(!state.sidebar));

  const btnEye = el('button', 'tb-icon');
  btnEye.addEventListener('click', () => setPinsHidden(!state.pinsHidden));

  const tbAvatar = el('span', 'tb-avatar');
  const grip = el('span', 'tb-grip');
  grip.append(icon('grip'));
  grip.title = 'Drag to move · double-click to reset · H hides the toolbar';
  toolbar.append(grip, btnMode, el('span', 'tb-divider'), btnThreads, btnEye, tbAvatar);

  /* ---------- draggable toolbar (dodge prototype's own bars) ---------- */

  const TB_POS = 'fp_tb_pos';

  function applyTbPos() {
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem(TB_POS) || 'null');
    } catch {
      pos = null;
    }
    if (!pos) {
      toolbar.style.left = '';
      toolbar.style.top = '';
      toolbar.style.bottom = '';
      toolbar.style.translate = '';
      return;
    }
    const r = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.min(Math.max(pos.x, 8), Math.max(8, innerWidth - r.width - 8))}px`;
    toolbar.style.top = `${Math.min(Math.max(pos.y, 8), Math.max(8, innerHeight - r.height - 8))}px`;
    toolbar.style.bottom = 'auto';
    toolbar.style.translate = 'none';
  }

  let tbDrag = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = toolbar.getBoundingClientRect();
    tbDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    grip.setPointerCapture(e.pointerId);
    toolbar.classList.add('dragging');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!tbDrag) return;
    const r = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.min(Math.max(e.clientX - tbDrag.dx, 8), innerWidth - r.width - 8)}px`;
    toolbar.style.top = `${Math.min(Math.max(e.clientY - tbDrag.dy, 8), innerHeight - r.height - 8)}px`;
    toolbar.style.bottom = 'auto';
    toolbar.style.translate = 'none';
  });
  const endTbDrag = () => {
    if (!tbDrag) return;
    tbDrag = null;
    toolbar.classList.remove('dragging');
    const r = toolbar.getBoundingClientRect();
    localStorage.setItem(TB_POS, JSON.stringify({ x: r.left, y: r.top }));
  };
  grip.addEventListener('pointerup', endTbDrag);
  grip.addEventListener('pointercancel', endTbDrag);
  grip.addEventListener('dblclick', () => {
    localStorage.removeItem(TB_POS);
    applyTbPos();
    toast('Toolbar back to its default spot');
  });
  window.addEventListener('resize', applyTbPos);

  function setPinsHidden(hidden) {
    state.pinsHidden = hidden;
    localStorage.setItem('fp_pins_hidden', hidden ? '1' : '0');
    pinsLayer.style.display = hidden ? 'none' : '';
    if (hidden) closePopover();
    renderToolbar();
  }

  function renderToolbar() {
    btnMode.classList.toggle('on', state.mode);
    const open = state.threads.filter((t) => !t.resolved).length;
    countBadge.textContent = open ? String(open) : '';
    btnThreads.classList.toggle('has-unread', state.threads.some(isUnread));
    btnEye.replaceChildren(icon(state.pinsHidden ? 'eyeOff' : 'eye'));
    btnEye.title = state.pinsHidden ? 'Show comment pins' : 'Hide comment pins';
    btnEye.setAttribute('aria-label', btnEye.title);
    btnEye.classList.toggle('dim', state.pinsHidden);
    tbAvatar.replaceChildren(avatar(state.role ? myLabel() : '?', 28));
    tbAvatar.title = `Signed in as ${state.role ? `${myLabel()} (${roleLabel()})` : '…'}`;
  }

  /* ---------- pins ---------- */

  const pinEls = new Map();

  function visiblePins() {
    // Every thread gets a pin element; positionPins() shows it only when its
    // anchor resolves on the current screen.
    return state.threads.filter((t) => (state.filter === 'resolved' ? t.resolved : !t.resolved));
  }

  function renderPins() {
    pinsLayer.replaceChildren();
    pinEls.clear();
    for (const t of visiblePins()) {
      const p = el('button', 'pin' + (t.resolved ? ' resolved' : ''), t.author.charAt(0).toUpperCase());
      p.style.background = pastel(t.author);
      if (isUnread(t)) p.appendChild(el('span', 'pin-dot'));
      if (t.id === state.active) p.classList.add('active');
      p.setAttribute('aria-label', `Comment by ${t.author}`);
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        openThread(t.id, p);
      });
      pinsLayer.appendChild(p);
      pinEls.set(t.id, p);
    }
    positionPins();
  }

  function positionPins() {
    for (const [id, p] of pinEls) {
      const t = state.threads.find((x) => x.id === id);
      if (!t || !onThisScreen(t)) {
        p.style.display = 'none';
        continue;
      }
      // Right page: anchor position if the element is here, otherwise the
      // stored approximate spot — a background comment stays on its page.
      const pos = resolveAnchor(t.anchor) || fracPos(t.anchor);
      if (!pos) {
        p.style.display = 'none';
        continue;
      }
      const off = pos.x < -40 || pos.y < -40 || pos.x > innerWidth + 40 || pos.y > innerHeight + 40;
      p.style.display = off ? 'none' : '';
      p.style.left = `${pos.x}px`;
      p.style.top = `${pos.y}px`;
    }
    if (state.draft && draftPin) {
      draftPin.style.left = `${state.draft.x}px`;
      draftPin.style.top = `${state.draft.y}px`;
    }
  }

  /* ---------- popover ---------- */

  function closePopover() {
    popover?.remove();
    popover = null;
    state.active = null;
    state.confirmDelete = null;
    shadow.querySelectorAll('.pin.active').forEach((p) => p.classList.remove('active'));
  }

  let draftPin = null;

  function cancelDraft() {
    state.draft = null;
    draftPin?.remove();
    draftPin = null;
    closePopover();
  }

  let lastPopAnchor = null;

  function placePopover(x, y) {
    lastPopAnchor = { x, y };
    // Visual viewport shrinks when the mobile keyboard opens; clamp to it so
    // the composer never hides behind the keyboard.
    const vw = window.visualViewport ? window.visualViewport.width : innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : innerHeight;
    const w = Math.min(320, vw - 24);
    const h = Math.min(popover.offsetHeight || 200, vh - 24);
    let px = x + 20;
    let py = y - 8;
    if (px + w > vw - 12) px = Math.max(12, x - w - 20);
    if (px < 12) px = 12;
    if (py + h > vh - 12) py = Math.max(12, vh - h - 12);
    if (py < 12) py = 12;
    popover.style.left = `${px}px`;
    popover.style.top = `${py}px`;
  }

  window.visualViewport?.addEventListener('resize', () => {
    if (popover && lastPopAnchor) placePopover(lastPopAnchor.x, lastPopAnchor.y);
  });

  function composeRow({ placeholder, onSubmit, bordered }) {
    const row = el('div', 'compose' + (bordered ? ' bordered' : ''));
    const ta = el('textarea');
    ta.placeholder = placeholder;
    ta.rows = 1;
    const send = el('button', 'send');
    send.append(icon('send'));
    send.disabled = true;
    send.setAttribute('aria-label', 'Post comment');
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
      send.disabled = !ta.value.trim();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (ta.value.trim()) onSubmit();
      }
    });
    send.addEventListener('click', onSubmit);
    row.append(ta, send);
    return { row, ta, send };
  }

  function openComposer() {
    closePopover();
    popover = el('div', 'popover');

    const { row, ta, send } = composeRow({
      placeholder: 'Add a comment',
      onSubmit: async () => {
        const text = ta.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          const { thread } = await api('POST', {
            action: 'create',
            text,
            screen: state.draft.screen || state.screen,
            screenLabel: state.draft.screenLabel || state.screenLabel,
            anchor: state.draft.anchor,
            proto: state.proto,
            page: location.pathname,
          });
          state.draft = null;
          draftPin?.remove();
          draftPin = null;
          state.filter = 'open'; // a fresh comment is always open — make its pin visible
          await refresh();
          closePopover();
          const pin = pinEls.get(thread.id);
          if (pin) openThread(thread.id, pin);
        } catch {
          toast('Couldn’t post — try again');
          send.disabled = false;
        }
      },
    });
    popover.appendChild(row);
    root.appendChild(popover);
    placePopover(state.draft.x, state.draft.y);
    ta.focus();
  }

  function openThread(id, pinEl) {
    closePopover();
    const t = state.threads.find((x) => x.id === id);
    if (!t) return;
    state.active = id;
    pinEl?.classList.add('active');

    popover = el('div', 'popover');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', `Comment by ${t.author}`);

    const head = el('div', 'head');
    const who = el('div', 'who');
    who.append(avatar(t.author, 24), el('span', 'name', t.author));
    const rb = roleBadge(t);
    if (rb) who.appendChild(el('span', 'badge', rb));
    if (t.proto && state.proto && t.proto !== state.proto) {
      who.appendChild(el('span', 'badge old-version', 'Older version'));
    }
    head.appendChild(who);

    const linkBtn = el('button', 'icon-btn');
    linkBtn.append(icon('link'));
    linkBtn.title = 'Copy link to comment';
    linkBtn.setAttribute('aria-label', 'Copy link to comment');
    linkBtn.addEventListener('click', async () => {
      const url = `${location.origin}${t.page || '/'}?comment=${t.id}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      } catch {
        toast(url, 6000);
      }
    });
    head.appendChild(linkBtn);

    const resolveBtn = el('button', 'icon-btn' + (t.resolved ? ' done' : ''));
    resolveBtn.append(icon('check'));
    resolveBtn.title = t.resolved ? 'Reopen' : 'Resolve';
    resolveBtn.setAttribute('aria-label', resolveBtn.title);
    resolveBtn.addEventListener('click', async () => {
      try {
        // Re-read the thread from current state: `t` may be an orphan if a
        // background poll replaced state.threads while the popover was open.
        const live = state.threads.find((x) => x.id === t.id) || t;
        const { thread } = await api('POST', { action: 'resolve', threadId: t.id, resolved: !live.resolved });
        closePopover();
        await refresh();
        toast(thread.resolved ? 'Marked as resolved' : 'Reopened');
      } catch {
        toast('Couldn’t update — try again');
      }
    });
    head.appendChild(resolveBtn);

    const canDelete = state.role === 'designer' || (t.authorRole === state.role && t.author === myLabel());
    if (canDelete) {
      const delBtn = el('button', 'icon-btn');
      delBtn.append(icon('trash'));
      delBtn.title = 'Delete thread';
      delBtn.setAttribute('aria-label', 'Delete thread');
      delBtn.addEventListener('click', async () => {
        if (state.confirmDelete !== t.id) {
          state.confirmDelete = t.id;
          delBtn.replaceChildren(el('span', null, 'Delete?'));
          delBtn.style.cssText = 'width:auto;padding:0 8px;color:#dc2626;font-size:12px;font-weight:500;';
          setTimeout(() => {
            if (state.confirmDelete === t.id && popover?.contains(delBtn)) {
              state.confirmDelete = null;
              delBtn.replaceChildren(icon('trash'));
              delBtn.style.cssText = '';
            }
          }, 3000);
          return;
        }
        try {
          await api('POST', { action: 'delete', threadId: t.id });
          closePopover();
          await refresh();
          toast('Comment deleted');
        } catch {
          toast('Couldn’t delete — try again');
        }
      });
      head.appendChild(delBtn);
    }

    const closeBtn = el('button', 'icon-btn');
    closeBtn.append(icon('close'));
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', closePopover);
    head.appendChild(closeBtn);
    popover.appendChild(head);

    if (!pinEl && !onThisScreen(t)) {
      const go = el('button', 'goto-row');
      go.append(icon('goto'), el('span', null, 'Go to comment'));
      if (t.screenLabel) go.appendChild(el('span', 'goto-screen', t.screenLabel));
      go.addEventListener('click', () => {
        closePopover();
        autoNavigate(t);
      });
      popover.appendChild(go);
    }

    const msgs = el('div', 'messages');
    for (const m of t.messages) {
      const box = el('div', 'msg');
      const meta = el('div', 'meta');
      meta.append(
        avatar(m.author, 20),
        el('span', 'name', m.author),
        el('span', 'time', timeAgo(m.at) + (m.edited ? ' · edited' : ''))
      );
      const textEl = el('div', 'text', m.text);
      if (m.author === myLabel() && m.role === state.role) {
        const editBtn = el('button', 'icon-btn msg-edit');
        editBtn.append(icon('edit'));
        editBtn.title = 'Edit';
        editBtn.setAttribute('aria-label', 'Edit message');
        editBtn.addEventListener('click', () => {
          const ta2 = el('textarea', 'msg-editor');
          ta2.value = m.text;
          textEl.replaceWith(ta2);
          ta2.focus();
          ta2.setSelectionRange(ta2.value.length, ta2.value.length);
          const done = async () => {
            const v = ta2.value.trim();
            if (!v || v === m.text) return openThread(t.id, pinEl);
            try {
              await api('POST', { action: 'edit', threadId: t.id, at: m.at, text: v });
              await refresh();
              openThread(t.id, pinEls.get(t.id) || pinEl);
            } catch {
              toast('Couldn’t save — try again');
            }
          };
          ta2.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              done();
            } else if (ev.key === 'Escape') {
              ev.stopPropagation();
              openThread(t.id, pinEl);
            }
          });
          ta2.addEventListener('blur', done);
        });
        meta.appendChild(editBtn);
      }
      box.append(meta, textEl);
      msgs.appendChild(box);
    }
    popover.appendChild(msgs);

    const { row, ta, send } = composeRow({
      placeholder: 'Reply',
      bordered: true,
      onSubmit: async () => {
        const text = ta.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          await api('POST', { action: 'reply', threadId: t.id, text });
          await refresh();
          openThread(t.id, pinEls.get(t.id));
        } catch {
          toast('Couldn’t reply — try again');
          send.disabled = false;
        }
      },
    });
    popover.appendChild(row);
    root.appendChild(popover);

    const pos = pinEl ? pinEl.getBoundingClientRect() : null;
    if (pos) placePopover(pos.left, pos.top);
    else placePopover(innerWidth - 680, 80);
    msgs.scrollTop = msgs.scrollHeight;

    // Opening a thread marks it read — clear the blue dots.
    if (isUnread(t)) {
      markRead([t]);
      renderToolbar();
      renderPins();
      if (state.sidebar) renderSidebar();
    }
  }

  /* ---------- sidebar ---------- */

  /* ---------- navigation graph (learned from real clicks) ---------- */

  // Every prototype click that changes the screen is recorded as an edge
  // (fromScreen --click anchor--> toScreen). "Go to comment" BFS-walks these
  // edges and replays the clicks to reach the comment's screen.
  const NAV_KEY = 'fp_nav2';

  function navMap() {
    try {
      return JSON.parse(localStorage.getItem(NAV_KEY) || '{}');
    } catch {
      return {};
    }
  }

  // Mid-transition screens can have no visible headings — screenLabel falls
  // back to document.title then. Such labels are phantom nodes: never learn
  // edges through them.
  const isFallbackLabel = (l) => l === (document.title || 'Screen');

  function saveEdge(from, to, anchor) {
    if (!from || !to || from === to || !anchor) return;
    if (isFallbackLabel(from) || isFallbackLabel(to)) return;
    const key = `${from}>${to}`;
    const m = navMap();
    const isNew = !m[key] && !state.nav[key];
    m[key] = anchor;
    const keys = Object.keys(m);
    while (keys.length > 300) delete m[keys.shift()];
    localStorage.setItem(NAV_KEY, JSON.stringify(m));
    // Share new transitions: anyone's walking teaches the graph for everyone,
    // so "Go to comment" works even on paths this browser never took.
    if (isNew) {
      state.nav[key] = anchor;
      api('POST', { action: 'edge', from, to, anchor }).catch(() => {
        delete state.nav[key];
      });
    }
  }

  let lastNavClick = null;
  document.addEventListener(
    'click',
    (e) => {
      if (e.composedPath().includes(host)) return;
      const raw = e.composedPath()[0];
      if (!(raw instanceof Element)) return;
      const target = raw.closest('button, a, [role="button"]') || raw;
      const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
      lastNavClick = {
        at: Date.now(),
        // Compute the label NOW: state.screen is debounce-stale during fast
        // clicking, and a wrong `from` poisons the graph with dead edges.
        from: screenLabel(),
        anchor: {
          path: buildPath(target),
          t: target.tagName.toLowerCase(),
          txt: s && s.length <= 60 ? s : null,
        },
      };
    },
    true
  );

  // One-time upload of edges this browser learned before the server graph
  // existed (or while offline) — the shared graph must not depend on luck.
  let edgeSyncDone = false;
  async function syncLocalEdges() {
    if (edgeSyncDone) return;
    edgeSyncDone = true;
    const missing = Object.entries(navMap())
      .filter(([k]) => !state.nav[k])
      .slice(0, 30);
    for (const [key, anchor] of missing) {
      const [from, to] = key.split('>');
      state.nav[key] = anchor;
      try {
        await api('POST', { action: 'edge', from, to, anchor });
      } catch {
        delete state.nav[key];
      }
    }
  }

  function findRoute(from, to, banned) {
    // Server graph wins on key collisions: it's collective and freshest,
    // while a browser's local graph may hold anchors from buggy old builds.
    const m = { ...navMap(), ...state.nav };
    const adj = {};
    for (const key of Object.keys(m)) {
      if (banned && banned.has(key)) continue;
      const [a, b] = key.split('>');
      (adj[a] ||= []).push({ to: b, anchor: m[key] });
    }
    const prev = { [from]: null };
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      for (const edge of adj[cur] || []) {
        if (!(edge.to in prev)) {
          prev[edge.to] = { cur, edge };
          queue.push(edge.to);
        }
      }
    }
    if (!(to in prev)) return null;
    const steps = [];
    let node = to;
    while (prev[node]) {
      steps.unshift(prev[node].edge);
      node = prev[node].cur;
    }
    return steps;
  }

  function waitForScreen(fp, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (labelsMatch(screenLabel(), fp)) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(iv);
          resolve(false);
        }
      }, 200);
    });
  }

  let navigating = false;
  let bootScreen = null; // the screen the prototype always starts on

  // A thread's stored label may predate the current label algorithm — map it
  // onto an existing graph node when an equivalent one exists.
  function graphTarget(label) {
    const m = { ...navMap(), ...state.nav };
    const nodes = new Set();
    for (const k of Object.keys(m)) {
      const [a, b] = k.split('>');
      nodes.add(a);
      nodes.add(b);
    }
    if (nodes.has(label)) return label;
    for (const n of nodes) if (labelsMatch(n, label)) return n;
    return label;
  }

  // Drive the prototype hop by hop, re-planning after every step: bad edges
  // happen (recorded on old builds, mis-attributed clicks) and a single one
  // must not kill the trip — ban it and route around from wherever we are.
  async function autoNavigate(t) {
    if (navigating) return;
    // Multi-page prototypes: the thread remembers its page — navigate there
    // directly; the deep-link boot on that page finishes the jump. Click
    // replay can't cross documents, so this is the only route that works.
    if (t.page && t.page !== location.pathname) {
      toastSticky('Taking you to the comment…');
      location.href = `${t.page}?comment=${t.id}`;
      return;
    }
    navigating = true;
    toastSticky('Taking you to the comment…');
    const target = graphTarget(t.screenLabel);
    const banned = new Set();
    try {
      for (let hop = 0; hop < 12; hop++) {
        const from = screenLabel();
        if (labelsMatch(from, t.screenLabel) || labelsMatch(from, target)) break;
        const route = findRoute(from, target, banned);
        if (!route || !route.length) {
          // No path from here — prototypes reset to the start screen on
          // reload, so teleport via reload when a path exists from the start.
          if (bootScreen && !labelsMatch(bootScreen, from) && findRoute(bootScreen, target, banned)) {
            localStorage.setItem('fp_jump', t.id);
            location.reload();
            return;
          }
          clearSticky();
          armGuided(t);
          return;
        }
        const step = route[0];
        const loc = locateAnchor(step.anchor);
        if (!loc.el) {
          banned.add(`${from}>${step.to}`);
          continue;
        }
        loc.el.click();
        if (!(await waitForScreen(step.to, 5000))) {
          banned.add(`${from}>${step.to}`);
          // fall through: next iteration re-plans from the actual screen
        }
      }
      state.screen = screenLabel();
      state.screenLabel = state.screen;
      if (labelsMatch(state.screen, t.screenLabel) || labelsMatch(state.screen, target)) {
        clearSticky();
        renderPins();
        jumpToThread(state.threads.find((x) => x.id === t.id) || t);
      } else {
        clearSticky();
        armGuided(t);
      }
    } catch {
      clearSticky();
      armGuided(t);
    } finally {
      navigating = false;
    }
  }

  /* ---------- jump to a comment ---------- */

  function pulsePin(p) {
    if (!p) return;
    p.classList.add('pulse');
    setTimeout(() => p.classList.remove('pulse'), 1000);
  }

  function cancelJump() {
    state.pendingJump = null;
    clearSticky();
  }

  // Fallback when no learned route exists: the user navigates manually and
  // the comment pops open the moment its screen shows.
  function armGuided(t) {
    setSidebar(false);
    state.pendingJump = t.id;
    toastSticky(
      `Navigate to “${t.screenLabel || 'the screen with this comment'}” — it will open there · Esc to cancel`
    );
  }

  function jumpToThread(t) {
    if (!onThisScreen(t)) {
      armGuided(t);
      return;
    }
    cancelJump();
    const loc = locateAnchor(t.anchor);
    const pos = loc.pos || fracPos(t.anchor);
    const openAtPin = () => {
      positionPins();
      const p = pinEls.get(t.id);
      openThread(t.id, p);
      pulsePin(p);
    };
    if (!pos) return openAtPin();
    const off = pos.x < 0 || pos.y < 0 || pos.x > innerWidth || pos.y > innerHeight;
    if (off && loc.el) {
      loc.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(openAtPin, 450);
    } else if (off) {
      const de = document.documentElement;
      window.scrollTo({ top: (t.anchor?.fy ?? 0.5) * de.scrollHeight - innerHeight / 2, behavior: 'smooth' });
      setTimeout(openAtPin, 450);
    } else {
      openAtPin();
    }
  }

  function checkPendingJump() {
    if (!state.pendingJump) return;
    const t = state.threads.find((x) => x.id === state.pendingJump);
    if (!t) return cancelJump();
    if (!onThisScreen(t)) return;
    jumpToThread(t);
  }

  function setSidebar(open) {
    state.sidebar = open;
    sidebar.classList.toggle('open', open);
    if (open) renderSidebar();
  }

  function renderSidebar() {
    sidebar.replaceChildren();

    const head = el('div', 'sb-head');
    head.appendChild(el('h2', null, 'Comments'));
    if (state.threads.some(isUnread)) {
      const mark = el('button', 'mark-read', 'Mark all read');
      mark.addEventListener('click', () => {
        markRead(state.threads);
        renderAll();
      });
      head.appendChild(mark);
    }
    const closeBtn = el('button', 'icon-btn');
    closeBtn.append(icon('close'));
    closeBtn.setAttribute('aria-label', 'Close comments');
    closeBtn.addEventListener('click', () => setSidebar(false));
    head.appendChild(closeBtn);
    sidebar.appendChild(head);

    const seg = el('div', 'seg');
    for (const f of ['open', 'resolved']) {
      const b = el('button', state.filter === f ? 'on' : '', f === 'open' ? 'Open' : 'Resolved');
      b.addEventListener('click', () => {
        state.filter = f;
        renderSidebar();
        renderPins();
      });
      seg.appendChild(b);
    }
    sidebar.appendChild(seg);

    const list = el('div', 'sb-list');
    const match = state.threads.filter((t) => (state.filter === 'resolved' ? t.resolved : !t.resolved));
    const here = match.filter(onThisScreen);
    const elsewhere = match.filter((t) => !onThisScreen(t));

    const addRows = (items, label) => {
      if (!items.length) return;
      list.appendChild(el('div', 'sb-group', label));
      // Ordering: unread first, then most recent activity.
      items = items
        .slice()
        .sort((a, b) => isUnread(b) - isUnread(a) || lastAt(b) - lastAt(a));
      for (const t of items) {
        const row = el('button', 'sb-row' + (t.resolved ? ' resolved' : '') + (isUnread(t) ? ' unread' : ''));
        const meta = el('div', 'meta');
        meta.append(avatar(t.author, 24), el('span', 'name', t.author));
        const rb = roleBadge(t);
        if (rb) meta.appendChild(el('span', 'badge', rb));
        if (t.resolved) {
          const c = el('span', 'check-ico');
          c.append(icon('check'));
          meta.appendChild(c);
        }
        meta.appendChild(el('span', 'time', timeAgo(lastAt(t))));
        if (isUnread(t)) meta.appendChild(el('span', 'row-dot'));
        row.appendChild(meta);
        row.appendChild(el('div', 'excerpt', t.messages[0]?.text || ''));
        if (t.messages.length > 1) {
          row.appendChild(el('div', 'replies', `${t.messages.length - 1} ${t.messages.length === 2 ? 'reply' : 'replies'}`));
        }
        row.addEventListener('click', () => {
          if (state.pinsHidden) setPinsHidden(false);
          if (onThisScreen(t)) {
            jumpToThread(t);
          } else {
            openThread(t.id, null); // other screen: popover carries Go to comment
          }
        });
        list.appendChild(row);
      }
    };

    addRows(here, 'On this screen');
    addRows(elsewhere, 'Other screens');

    if (!match.length) {
      list.appendChild(
        el(
          'div',
          'sb-empty',
          state.filter === 'open'
            ? matchMedia('(pointer: coarse)').matches
              ? 'No open comments yet. Tap Comment, then tap anywhere on the prototype to leave the first one.'
              : 'No open comments yet. Press C, then click anywhere on the prototype to leave the first one.'
            : 'Nothing resolved yet.'
        )
      );
    }
    sidebar.appendChild(list);

    const foot = el('div', 'sb-foot');
    foot.appendChild(el('span', 'me', `Signed in as ${myLabel()} · ${roleLabel()}`));
    const out = el('a', null, 'Sign out');
    if (EMBED) {
      out.href = '#';
      out.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem(TOKEN_KEY);
        location.reload();
      });
    } else {
      out.href = '/api/logout';
    }
    foot.appendChild(out);
    sidebar.appendChild(foot);
  }

  /* ---------- comment mode ---------- */

  function setMode(on) {
    state.mode = on;
    clickLayer.hidden = !on;
    if (on && state.pinsHidden) setPinsHidden(false);
    renderToolbar();
    if (on) closePopover();
  }

  clickLayer.addEventListener('click', (e) => {
    const anchor = buildAnchor(e.clientX, e.clientY);
    cancelDraft();
    state.screen = screenLabel();
    state.screenLabel = screenLabel();
    state.draft = {
      x: e.clientX,
      y: e.clientY,
      anchor,
      screen: state.screen,
      screenLabel: state.screenLabel,
    };
    draftPin = el('button', 'pin draft', '+');
    draftPin.style.left = `${e.clientX}px`;
    draftPin.style.top = `${e.clientY}px`;
    draftPin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cancelDraft();
    });
    pinsLayer.appendChild(draftPin);
    setMode(false);
    openComposer();
  });

  /* ---------- global events ---------- */

  function toggleToolbar() {
    const hidden = toolbar.style.display === 'none';
    toolbar.style.display = hidden ? '' : 'none';
    if (!hidden) toast('Toolbar hidden — press H to bring it back', 4000);
  }

  document.addEventListener('keydown', (e) => {
    const target = e.composedPath()[0];
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === 'Escape') {
      if (state.draft) cancelDraft();
      else if (popover) closePopover();
      else if (state.pendingJump) cancelJump();
      else if (state.mode) setMode(false);
      else if (state.sidebar) setSidebar(false);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    // e.code — layout-independent (works on Cyrillic layouts too)
    if (e.code === 'KeyC') setMode(!state.mode);
    else if (e.code === 'KeyH') toggleToolbar();
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!popover && !state.draft) return;
      if (e.composedPath().includes(host)) return;
      if (state.draft) cancelDraft();
      else closePopover();
    },
    true
  );

  /* ---------- watchers ---------- */

  let mutTimer = null;
  function onMutate() {
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      // Never cancel an open draft or thread here: app-driven mutations
      // (animations, async data) must not eat a comment mid-typing.
      const prevScreen = state.screen;
      state.screen = screenLabel();
      state.screenLabel = screenLabel();
      if (
        state.screen !== prevScreen &&
        lastNavClick &&
        lastNavClick.from === prevScreen &&
        Date.now() - lastNavClick.at < 2500
      ) {
        saveEdge(prevScreen, state.screen, lastNavClick.anchor);
        lastNavClick = null;
      }
      detectTheme();
      positionPins();
      checkPendingJump();
      if (state.sidebar) renderSidebar();
    }, 250);
  }

  new MutationObserver(onMutate).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    // class/style flips are how prototypes switch themes and screens
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  window.addEventListener('resize', onMutate);
  document.addEventListener('scroll', () => requestAnimationFrame(positionPins), {
    capture: true,
    passive: true,
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);

  // Long-lived tabs are the #1 source of "it doesn't work" reports: they keep
  // running an outdated overlay. Compare our asset's ETag every 30 min and
  // nudge for a refresh when a new version ships.
  let overlayEtag = null;
  let staleNotified = false;
  async function checkOverlayVersion() {
    try {
      const r = await fetch((EMBED ? API_ORIGIN : '') + '/overlay.js', {
        method: 'HEAD',
        cache: 'no-store',
      });
      const tag = r.headers.get('etag');
      if (!tag) return;
      if (overlayEtag === null) overlayEtag = tag;
      else if (tag !== overlayEtag && !staleNotified) {
        staleNotified = true;
        toast('Commenting got an update — refresh the page to use it', 8000);
      }
    } catch {
      /* offline — ignore */
    }
  }
  checkOverlayVersion();
  setInterval(() => {
    if (document.visibilityState === 'visible') checkOverlayVersion();
  }, 30 * 60 * 1000);

  /* ---------- boot ---------- */

  function renderAll() {
    renderToolbar();
    renderPins();
    if (state.sidebar) renderSidebar();
  }

  if (state.pinsHidden) pinsLayer.style.display = 'none';
  state.screen = screenLabel();
  state.screenLabel = screenLabel();
  detectTheme();

  // Prototype version = hash of the served page; threads remember the version
  // they were left on, so updated prototypes show an "Older version" badge.
  fetch('/', { cache: 'no-store' })
    .then((r) => r.text())
    .then((html) => {
      let h = 5381;
      for (let i = 0; i < html.length; i++) h = ((h << 5) + h + html.charCodeAt(i)) >>> 0;
      state.proto = 'v' + h.toString(36);
    })
    .catch(() => {});

  // Deep link: /?comment=<id> — strip it from the URL immediately (a
  // reload-teleport must not re-trigger it) and jump after boot.
  const deepLink = new URLSearchParams(location.search).get('comment');
  if (deepLink) history.replaceState(null, '', location.pathname);

  setTimeout(() => {
    state.screen = screenLabel();
    state.screenLabel = screenLabel();
    bootScreen = state.screen;
    detectTheme();
    applyTbPos();
    renderPins();
    // Continue a reload-teleport or serve a deep link: replay the learned
    // route to the comment from the start screen.
    const jump = localStorage.getItem('fp_jump') || deepLink;
    if (jump) {
      localStorage.removeItem('fp_jump');
      toastSticky('Taking you to the comment…');
      const go = () => {
        const t = state.threads.find((x) => x.id === jump);
        if (t) {
          if (onThisScreen(t)) jumpToThread(t);
          else autoNavigate(t);
        } else clearSticky();
      };
      if (state.threads.length) setTimeout(go, 800);
      else refresh().then(() => setTimeout(go, 800));
    }
  }, 1200);

  refresh().then(() => {
    syncLocalEdges();
    if (!localStorage.getItem('fp_hint')) {
      localStorage.setItem('fp_hint', '1');
      const touch = matchMedia('(pointer: coarse)').matches;
      toast(
        touch
          ? 'Tap Comment, then tap anywhere to leave feedback'
          : 'Press C or click Comment to leave feedback',
        5000
      );
    }
  });
})();
