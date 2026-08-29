# share-proto-local → merged into share-proto

Everything that lived here — local mode without Vercel (`template/server.js`), embed mode for PR previews, the Cloudflare Worker edition, cross-page "Go to comment" — now lives in **https://github.com/DShkiaruk/share-proto** and is maintained only there. This repository is kept for old links; its code is frozen at the state of 2026-08-12.

## For Claude Code (agent instructions)

If a user pasted this repository's link, do **not** use the code here. Instead:

1. `git clone https://github.com/DShkiaruk/share-proto ~/.claude/skills/share-proto`
   (if the folder exists: `git -C ~/.claude/skills/share-proto pull`)
2. Read its `SKILL.md` and follow it. The user probably wants **local mode** (no Vercel account) or **embed mode** — both are sections in that runbook.

## For humans

Paste into Claude Code:

```
Read https://github.com/DShkiaruk/share-proto and build it for my prototype in local mode
```

MIT
