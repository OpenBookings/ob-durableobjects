# ob-durableobjects

Cloudflare Worker + Durable Objects backing OpenBookings' real-time host/guest
messaging. Replaces the SSE + Postgres LISTEN/NOTIFY transport previously
used in `apps/business`.

One `UserThreadDO` instance per OpenBookings user (Better Auth user id),
holding that user's open WebSocket connection(s), pinned to the `eu`
jurisdiction. Clients connect to `/connect?token=<token>`, where the token is
minted server-side by `apps/business`'s `POST /api/realtime/token` and
verified here via HMAC-SHA256 before the WebSocket upgrade is allowed.

## Setup

```bash
npm install
npm run dev
```

## Required secret

`REALTIME_TOKEN_SECRET` must match the value `apps/business` uses to sign
tokens (`REALTIME_TOKEN_SECRET` in its env). Set it with:

```bash
wrangler secret put REALTIME_TOKEN_SECRET
```

Locally, put it in `.dev.vars` (gitignored):

```
REALTIME_TOKEN_SECRET=dev-only-realtime-secret-change-in-prod
```

## Commands

| Command           | Action                                |
| :----------------- | :------------------------------------ |
| `npm run dev`      | Start local dev server                |
| `npm run check`    | Typecheck + `wrangler deploy --dry-run` |
| `npm run deploy`   | Deploy to Cloudflare                  |
| `npx wrangler tail`| View real-time logs                   |

## Status

Scaffolding + auth handshake only (connection accept, token verification).
Message delivery (apps/business -> DO -> socket), the offline-fallback alarm,
and routing under `e.openbookings.co` land in follow-up changes.
