# Bookmark Sync

> One bookmark library across every browser and device.

Privacy-conscious, cross-browser bookmark synchronization. The first milestone:
**two browser installations belonging to the same user can synchronize bookmark
creation, updates, moves, folders, and deletion without creating sync loops.**

Supported browsers:

| Browser | Engine target | Adapter |
| --- | --- | --- |
| Brave | Chromium (MV3) | `chromiumAdapter` |
| Helium | Chromium (MV3) | `chromiumAdapter` |
| Zen | Firefox (WebExtensions) | `firefoxAdapter` |

Chrome, Edge, Arc and other WebExtensions browsers can be added by writing a new
adapter only — the sync protocol, engine, and database model are browser-agnostic.

## Repository layout

```text
apps/
  extension/   WXT + React browser extension (background service worker + popup)
  api/         Hono API deployed to Cloudflare Workers
  web/         Minimal dashboard (Vite + React, Cloudflare Pages)
packages/
  shared/      Zod schemas and types: operations, protocol contracts, IDs
  sync/        Deterministic sync engine (pure functions, fully unit-tested)
  db/          Drizzle ORM schema, migrations, Neon PostgreSQL client
docs/
  architecture.md   ID model, conflict strategy, loop prevention, limitations
```

## Quick start

Prerequisites: [Bun](https://bun.sh), Docker (optional, for local Postgres
integration tests).

### 1. Install

```bash
bun install
```

### 2. Run the database migrations

Create a Neon project (or use any PostgreSQL instance for development), then:

```bash
export DATABASE_URL="postgres://..."
bun run --cwd packages/db migrate
```

### 3. Start the API

```bash
bun run --cwd apps/api dev                          # http://localhost:8787
curl http://localhost:8787/health                   # → {"ok":true,...}
```

The dev server runs the same Hono app on Bun and reads `DATABASE_URL` from
the environment or `apps/api/.dev.vars` (see `.dev.vars.example`). Any
PostgreSQL URL works locally; Neon URLs automatically switch to the
Workers-compatible HTTP driver. Deploying/bundling uses Wrangler, which
requires Node.js ≥ 22 (`nvm use 22`) — see the scripts in `apps/api`.

### 4. Load the extension

Chromium (Brave/Helium):

```bash
bun run --cwd apps/extension build          # output: apps/extension/.output/chrome-mv3
```

Load `.output/chrome-mv3` via `chrome://extensions` → Developer mode → "Load unpacked".

Firefox/Zen:

```bash
bun run --cwd apps/extension build:firefox  # output: apps/extension/.output/firefox-mv2
```

Load `.output/firefox-mv2` via `about:debugging#/runtime/this-hub` → "Load Temporary Add-on".

Open the popup, enter an email, press **Connect**. Repeat on a second browser
with the same email; bookmarks now synchronize between them.

### 5. Dashboard (optional)

```bash
bun run --cwd apps/web dev                  # http://localhost:5173
```

## Development commands

```bash
bun run typecheck        # strict TypeScript across all workspaces
bun test                 # engine unit tests + API smoke/integration tests

# API integration tests need a disposable Postgres:
docker run -d --name syncer-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16-alpine
TEST_DATABASE_URL="postgres://postgres:postgres@localhost:54329/postgres" bun test apps/api
```

## Environment variables

Copy `.env.example` and fill in values. Server-only secrets (`DATABASE_URL`)
must never reach the extension or dashboard; the extension talks to the API
only. See `apps/api/.dev.vars.example` for local Worker secrets.

## Deployment

| Component | Target | Command |
| --- | --- | --- |
| API | Cloudflare Workers | `bun run --cwd apps/api deploy` (+ `wrangler secret put DATABASE_URL`) |
| Web | Cloudflare Pages | `bun run --cwd apps/web deploy` |
| Extension | Chrome Web Store / AMO | `bun run --cwd apps/extension zip` |

## Security notes

* Development authentication (`POST /auth/dev/register`) exchanges any email
  for a bearer token without verification. It is explicitly temporary; replace
  it before exposing the API publicly. The sync engine deliberately knows
  nothing about the auth scheme so it can be swapped without rewrites.
* Device tokens are stored server-side as SHA-256 hashes; plaintext tokens are
  shown once at registration.
* No secrets are bundled into the extension; the API URL is user-configurable.

See `docs/architecture.md` for the synchronization design in depth.
