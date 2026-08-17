# share-proto-local

Ship any HTML prototype as a password-protected link with a built-in commenting layer: pins on the exact spot, threads, replies, resolve, unread dots, one-click "Go to comment" navigation (across pages too), dark-theme auto-matching, mobile support.

A standalone edition of [share-proto](https://github.com/DShkiaruk/share-proto) that also runs **fully local — no Vercel account needed**: one zero-dependency Node server (`template/server.js`) does the password gate and stores comments in a JSON file, and a `cloudflared` tunnel gives a temporary share link that dies when you stop the process. Built for reviewing snapshot sets of real product screens (e.g. SingleFile exports) without hosting anything anywhere.

Two roles, one link: **designers see every comment, the client sees only client comments** — enforced on the server, not hidden in the UI. Everyone signs in with their name, so every comment is attributed.

## How to use

Paste this into Claude Code:

```
Read https://github.com/DShkiaruk/share-proto-local and build it for my prototype
```

Then tell it where the prototype is — a local HTML file or a URL if it's already online. Claude installs whatever is missing (Vercel CLI, storage), walks you through a free Vercel signup if you don't have one, and finishes with **the share link and two passwords** — one for your team, one for the client.

One-time requirements: Claude Code and a free [vercel.com](https://vercel.com) account (the agent opens signup for you, ~2 min).

**Can't host it externally?** There is a local mode: `node server.js` runs the same gate + comments on your machine with zero dependencies (comments in a local JSON file), and `cloudflared tunnel` gives a temporary share link that dies when you stop the process. See "Local mode" in `SKILL.md`.

**Reviewing someone else's deployment (e.g. PR previews)?** There is an embed mode: one `<script src="https://<comments-host>/overlay.js" defer>` tag on any page turns it commentable — token auth in an in-overlay login modal, comments partitioned per `pr-N` hostname, CORS locked via `ALLOWED_ORIGINS`. See "Embed mode" in `SKILL.md`.

## For Claude Code (agent instructions)

When a user shares this repository link and asks to build/share/publish a prototype or add commenting to one:

1. Clone the repository if it's not present locally:
   `git clone https://github.com/DShkiaruk/share-proto-local ~/.claude/skills/share-proto-local`
   (if the folder exists, update it: `git -C ~/.claude/skills/share-proto-local pull`)
2. Read `SKILL.md` at the repo root and follow it step by step. It covers three input cases (a local HTML file, a URL of an already-deployed prototype, a project already linked to Vercel) plus a local no-Vercel mode (`template/server.js`).
3. **Mandatory output**: your final message must end with the prominent block from SKILL.md step 7 — the share link and both passwords. Never bury them in prose.

## What's inside

```
SKILL.md              — the step-by-step runbook (also works as a Claude Code skill)
scripts/assemble.py   — deterministic project assembly from the template
template/             — the complete system: auth middleware, comments API, overlay UI
```

The template is self-contained: append-only comment storage on Vercel Blob (immune to CDN caching), element-anchored pins, a shared navigation graph that powers "Go to comment", automatic dark-theme matching. Don't rewrite its internals — they encode lessons that aren't reproducible from the code alone (see "Hard rules" in SKILL.md).

## How reviewers leave comments

Sign in with a name + password (the password decides the role). Press **C** or hit Comment → click anywhere → type → Enter. The Threads sidebar lists everything: unread threads carry a blue dot, "Go to comment" navigates the prototype to the right screen by itself. **H** hides the toolbar. Reviewers can edit their own messages, copy a direct link to any comment, and comments left on an outdated build get an "Older version" badge.

## Limitations

- The prototype must be a self-contained HTML file (fonts/libraries from CDNs are fine).
- Vercel's free Hobby plan is formally for non-commercial use (Pro is $20/mo if needed).
- Read state is per browser; there are no notifications outside the page (deliberate).

MIT
