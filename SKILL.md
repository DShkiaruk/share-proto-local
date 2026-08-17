---
name: share-proto-local
description: Share an HTML prototype (or a set of frozen snapshots of real product screens) behind a password with a built-in comment layer (pins, threads, replies, resolve, cross-page Go to comment). Two passwords = two roles — designers see all comments, the client sees only client comments (enforced server-side). Runs fully local with zero dependencies (no Vercel account needed) or deploys to Vercel. Use when the user wants to share a prototype or screens for feedback, e.g. "share my prototype", "add comments to my prototype", "let the client leave comments".
---

# Share a prototype with comments

Output: a live password-protected URL + two passwords (designers / client). One shared link; the name + password entered at login decide who the person is and what they see.

The `template/` next to this file already contains the whole system — auth middleware, comments API, overlay UI. It is battle-tested; **assemble it, don't rebuild it**.

## Input cases — pick by what the user has

- **A. Local HTML file** (prototype not online yet): follow all steps below.
- **B. URL of an online prototype** (deployed anywhere, no local file): download it first — `curl -sL <url> -o /tmp/proto.html` — then follow all steps with that file. The result is a NEW protected URL; remind the user the old public URL stays open and they may want to take it down.
- **C. Local project already deployed to Vercel** (has `.vercel/` link, e.g. made by this skill earlier or a plain static deploy): install the tool in place instead of assembling fresh — copy `template/`'s `api/`, `lib/`, `middleware.js`, `vercel.json`, `package.json` deps, and `public/overlay.js`, `public/overlay.css`, `public/login.html`, `public/favicon.svg` into the project; inject the overlay tag + viewport into its HTML entry (reuse the injection logic from `assemble.py`); then continue from step 3 (secrets) in that directory. Same domain keeps working.

If it's unclear which case applies, ask one short question.

## Local mode — no Vercel

Same system without deploying anywhere: `template/server.js` (plain Node >= 18, zero npm deps — no `npm install`) replaces middleware + `api/*` + Blob with one local process. Comments live in `data/comments.json`. Pick this when the prototype must not be hosted externally (client security policy), the user has no Vercel account, or the link should exist only for the duration of the review.

1. **Assemble** as usual with `assemble.py`, then instead of steps 3–5:
2. **Run**: `cd <target-dir> && node server.js` (options: `--port <n>`, default 3456). First run generates both passwords + a session secret into `data/secrets.json` and prints them with the URL; they survive restarts. Env vars `DESIGNER_PASSWORD` / `CLIENT_PASSWORD` / `SESSION_SECRET` override.
3. **Share beyond localhost** (optional): `cloudflared tunnel --url http://localhost:3456` (`brew install cloudflared` if missing) → temporary `trycloudflare.com` URL. The link exists only while both processes run and the machine is awake — tell the user this is a feature (nothing stays hosted) and a constraint (laptop must stay on during review). Passwords still gate access; cookies work through the tunnel (`Secure` is added when `x-forwarded-proto` says https).
4. **Smoke test**: same checks as step 6 below, against `http://localhost:<port>`.
5. **Hand over**: same block as step 7 with the tunnel URL; add that comments persist in `data/comments.json` (delete the file to wipe; don't commit `data/` — it holds the passwords).

**App-build case** (the prototype is a static build of a real app, many files — e.g. a demo build with mocked APIs): assemble any placeholder HTML first, then replace `public/index.html` and add the build's assets into `public/`, keeping `overlay.js`, `overlay.css`, `login.html`, `favicon.svg` in place; inject `<script src="/overlay.js" defer></script>` before `</body>` of the build's index.html (assemble.py's injection logic). If the app uses client-side routing, run `node server.js --spa` (serves index.html for extension-less paths). Never point such a build at a real backend — mock the data layer first; this server only adds the gate + comments.

## Embed mode — overlay on someone else's page

The overlay can be dropped into a page it does not serve (e.g. a client's PR
preview on S3/CloudFront) with a single tag:

```html
<script src="https://<comments-host>/overlay.js" defer></script>
```

It detects embed mode by comparing the script's origin to the page's origin.
Everything then adapts automatically:

- **API + assets** go to the script's origin (the comments host).
- **Auth** is a Bearer token (cross-site cookies don't survive): an in-overlay
  login modal appears instead of the login page; the token lives in the
  preview origin's localStorage. Login still returns `{role}` for classic
  installs — embed additionally uses the `token` field.
- **Rooms**: comments are partitioned per preview — hostname `pr-N.<domain>`
  → room `pr-n` (other hostnames slug to a room name). Query param `room=` on
  `/api/comments`; server-side storage nests under `rooms/<room>/` (Blob) or
  `store.rooms[<room>]` (local server). Classic same-origin traffic keeps the
  old paths / room `_`.
- **CORS**: the comments host must set `ALLOWED_ORIGINS` (comma-separated,
  `*` matches one hostname label run): e.g.
  `ALLOWED_ORIGINS=https://pr-*.preview.acme.com`. Unlisted origins get no
  CORS headers and the browser blocks the call. `/overlay.js`+`/overlay.css`
  are served with `Access-Control-Allow-Origin: *` (public script; the HEAD
  version-check needs it).

Deployment of the comments host is just the normal flow (Vercel steps below,
or Local mode) — the assembled `public/index.html` is irrelevant to embedded
pages; only `/overlay.js`, `/overlay.css` and `/api/*` matter. Set
`ALLOWED_ORIGINS` as an env var in both cases.

## Hard rules

- **Never rewrite `api/comments.js` storage logic.** It is append-only on purpose: Vercel Blob's CDN caches overwritten blobs for ~60s, so overwriting = replies/resolves silently reverting. Every mutation writes a new immutable blob + snapshot.
- **Never remove the overlay's anchor model** (path + tag + text-hint). Screen-hash approaches break on responsive prototypes that render different DOM per breakpoint.
- The client role must never receive designer threads from the API. If you touch the API, re-verify this before finishing.

## Steps

### 1. Preflight

- Locate the HTML file (from the user's message; search `~/Downloads` if they gave just a name). Confirm it contains `</body>`.
- **Node/npm**: `command -v npm` — if missing, try `brew install node` (macOS with Homebrew). No brew either → send the user to https://nodejs.org (LTS installer), wait, re-check. Don't proceed without npm.
- **Vercel CLI**: `command -v vercel || npm i -g vercel`
- **Vercel account**: `vercel whoami` — if it fails, walk the user through registration instead of just failing:
  1. Explain (in the user's language) why this is needed: Vercel is what puts the prototype online — it hosts the page, runs the password/role check, and stores the comments. Free Hobby plan is enough.
  2. Open the signup page for them: `open "https://vercel.com/signup"` — recommend continuing with Google (fastest), plan "Hobby".
  3. Once they confirm the account exists, tell them to type `! vercel login` in the prompt (login happens in their terminal + browser; you cannot do it for them).
  4. Re-run `vercel whoami` and continue only when it prints a username.
- Pick a project name: kebab-case from the file/product name, e.g. `acme-proto`. Ask only if ambiguous.

### 2. Assemble

```bash
python3 <skill-dir>/scripts/assemble.py "<prototype.html>" ~/<name>-share
cd ~/<name>-share && npm install
```

The script copies the template, injects the overlay tag, fixes the viewport meta, and titles the login page from the prototype's `<title>`.

### 3. Link + secrets

```bash
cd ~/<name>-share
vercel link --yes --project <name>
```

Generate: `PASS_TEAM="<name>-team-$(openssl rand -hex 2)"`, `PASS_CLIENT="<name>-client-$(openssl rand -hex 2)"`, `SECRET=$(openssl rand -hex 32)`. Then for `production` and `development` (skip `preview` — it prompts interactively and isn't needed):

```bash
printf '%s' "$PASS_TEAM"   | vercel env add DESIGNER_PASSWORD production
printf '%s' "$PASS_CLIENT" | vercel env add CLIENT_PASSWORD production
printf '%s' "$SECRET"      | vercel env add SESSION_SECRET production
# repeat with `development`
```

### 4. Blob store (comments storage)

The CLI's link prompt needs a real TTY — drive it with `expect` (preinstalled on macOS):

```bash
cat > /tmp/blob-link.exp <<'EOF'
#!/usr/bin/expect -f
set timeout 60
spawn vercel blob create-store <name>-comments --access public
expect {
  -re {link this blob store.*} { send "y\r"; exp_continue }
  -re {Select environments.*} { sleep 1; send "\r"; exp_continue }
  eof { }
  timeout { exit 2 }
}
EOF
expect /tmp/blob-link.exp
vercel env ls | grep BLOB_READ_WRITE_TOKEN   # must exist before continuing
```

If the token is missing: `vercel blob list-stores --all`, delete the orphan store with `vercel blob delete-store <id> --yes`, re-run the expect script.

**Manual fallback** (no `expect`, e.g. non-macOS, or the script keeps failing): the store can be connected in the dashboard — tell the user to open vercel.com → Storage → the `<name>-comments` store → Connect Project → pick the project, all environments. Then verify `BLOB_READ_WRITE_TOKEN` appears in `vercel env ls`.

### 5. Deploy + find the real domain

```bash
vercel deploy --prod --yes
vercel project ls   # the production domain is in this output
```

**Trap:** the domain is NOT always `<name>.vercel.app` — if the name is taken by another Vercel user you get a suffixed domain (e.g. `<name>-sigma.vercel.app`). Always take the domain from `vercel project ls` and smoke-test THAT domain, otherwise you may be testing a stranger's site.

### 6. Smoke test (curl, against the real domain)

- `GET /` without cookies → login page HTML (`protected prototype` in title)
- `POST /api/login {"password": "$PASS_TEAM"}` → `{"role":"designer"}`; wrong password → 401
- `POST /api/login {"password": "$PASS_CLIENT"}` → `{"role":"client"}`
- With designer cookie: `GET /` → prototype HTML containing `overlay.js`; `GET /api/comments` → `{"role":"designer","threads":[]}`
- `GET /api/comments` without cookie → 401
- Optional deeper check: create a comment as client, confirm designer GET returns it and that a designer-created thread is absent from client GET. Then wipe: `vercel blob empty-store --yes`.

### 7. Hand over — REQUIRED output format

End your final message with this standout block (translated to the user's language). The link and both passwords are MANDATORY and must be visually prominent — never bury them in prose:

> ## 🔗 Share link
> **https://<real-domain>**
>
> 🔑 **Team password:** `<team password>`
> 🔑 **Client password:** `<client password>`
>
> Everyone signs in with their name — all comments are attributed.

Then briefly, in prose:

- How reviewers use it: press **C** (or tap Comment) → click anywhere → type → Enter. Threads sidebar lists everything; resolve with the check icon; H hides the toolbar.
- Roles: designers see all comments; the client sees only client comments (server-enforced).
- To update the prototype later: run assemble.py again into a fresh dir? No — simpler: replace `public/index.html` with the new export, re-add the `<script src="/overlay.js" defer></script>` line before `</body>` (assemble.py's injection), then `vercel deploy --prod --yes`. Comments survive — they live in Blob, keyed to elements.
- To wipe all comments: `vercel blob empty-store --yes` from the project dir.

## Notes

- Vercel Hobby plan formally requires Pro for commercial/client work; the deploy works either way — mention it once.
- The overlay is design-neutral (near-black on white, Geist). If the prototype's brand clashes hard, you may re-tint the CSS variables at the top of `public/overlay.css` — optional, don't gold-plate.
- Multi-page prototypes (several HTML files): put extra pages in `public/` and inject the overlay tag into each; comments work per-page automatically. Threads remember their page (`page` field), so "Go to comment" navigates across pages by direct URL + deep link — no learned click-graph needed between files.
- Snapshot sets (frozen pages saved from a real app, e.g. SingleFile exports — scripts stripped, buttons dead): same as multi-page, plus generate a minimal neutral `index.html` listing the screens (styled like login.html), because frozen pages have no working navigation of their own. Reviewers browse via the index; "Go to comment" still teleports them directly.

## Capturing snapshots from a running app (agent recipe)

When the "prototype" is a real app running locally (a dev server) rather than an HTML file, capture the frozen snapshots yourself — do NOT ask the user to click through a browser extension manually, and do NOT tunnel/deploy/share the running app itself.

1. Get from the user: the local app URL and a test account (or ask them to log in once in the browser you drive). Propose the screen/state list yourself from the feature's code — include non-happy states (open panels, hover tooltips, validation errors, empty states), not just the default view.
2. Drive the app with Playwright (or your browser tool): arrange each state, then serialize the page to ONE self-contained HTML — inject `single-file-core` (npm: `single-file-cli`) into the page and invoke it, or an equivalent serializer that inlines CSS/images/fonts and strips scripts. `page.content()` alone is NOT enough: external CSS/asset URLs would keep pointing at the app. States that exist only as CSS `:hover` need the class/state forced onto the element before serializing.
3. Neutralize navigation in every snapshot: the serialized HTML bakes in the app's real links (`<a href>` often absolute `http://localhost:<port>/...`) and form actions — one click would dump the reviewer into the user's live dev server. Strip or replace every `href` with `javascript:void(0)` (keep the visual), remove `target`, and empty `<form action>`. Then click-sweep the saved file: no click anywhere may navigate off the page.
4. Verify every snapshot before building: renders offline (zero network requests), `grep` finds no backend/API domains, keys, or tokens in the HTML (including in leftover hrefs), and no real personal data is visible on screen (test-account data only).
5. Continue with the Snapshot sets case above (index page, assemble, local mode or Vercel).
