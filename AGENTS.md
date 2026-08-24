# Bookmark Sync — Agent Instructions

## Project Overview

Build a privacy-conscious, cross-browser bookmark synchronization system that synchronizes bookmarks across multiple browsers and devices.

## Initial Browser Targets

The first supported browsers are:

- Brave
- Helium
- Zen Browser

Brave and Helium should use a shared Chromium/WebExtensions implementation wherever their APIs are compatible.

Zen Browser should use the Firefox/WebExtensions implementation.

Do not create separate synchronization engines for individual browsers.

Browser-specific differences must be isolated inside browser adapters.

The architecture should allow Chrome, Edge, Firefox, Arc, and other WebExtensions-compatible browsers to be added later without changing the synchronization protocol or database model.

The project should begin as a personal/free-to-run system, but the architecture must allow it to grow into a public product later.

The system consists of:

1. A browser extension that reads and modifies browser bookmarks.
2. A synchronization API.
3. A PostgreSQL database.
4. A web dashboard for authentication, device management, and bookmark inspection.
5. A synchronization engine capable of handling creation, modification, movement, and deletion of bookmarks and folders.

---

## Core Technology Stack

Use the following stack unless there is a strong technical reason not to.

### Runtime and package management

* Bun
* Bun workspaces
* TypeScript

Do not introduce npm, pnpm, yarn, or another package manager unless explicitly required.

### Browser extension

* WXT
* React
* TypeScript
* WebExtensions APIs
* Manifest V3 for Chromium browsers
* Firefox-compatible WebExtensions APIs

The extension should use browser APIs rather than attempting to manipulate browser profile files directly.

### API

* Hono
* Cloudflare Workers
* TypeScript

The API should remain portable and avoid unnecessary runtime-specific APIs so that migration to another deployment platform remains possible.

### Database

* Neon PostgreSQL
* Drizzle ORM
* Drizzle Kit

The database schema must be version-controlled through Drizzle migrations.

### Web dashboard

* React
* TypeScript
* Vite unless there is a compelling reason to use another framework
* Cloudflare Pages for deployment

The dashboard is secondary to the extension and sync engine.

---

## Repository Structure

Use a Bun monorepo.

Preferred structure:

```text
bookmark-sync/
├── apps/
│   ├── extension/
│   ├── api/
│   └── web/
│
├── packages/
│   ├── db/
│   ├── sync/
│   └── shared/
│
├── docs/
│
├── AGENTS.md
├── START.md
├── package.json
├── bun.lock
├── tsconfig.json
└── README.md
```

### Responsibilities

`apps/extension`

Browser extension, popup, options page, background service worker, bookmark listeners, local synchronization state, authentication flow, and browser-specific adapters.

`apps/api`

Hono API deployed to Cloudflare Workers.

`apps/web`

Optional account/dashboard website deployed to Cloudflare Pages.

`packages/db`

Drizzle schema, migrations, database utilities, and typed database access.

`packages/sync`

Synchronization engine, conflict handling, operation processing, and reconciliation logic.

`packages/shared`

Types, schemas, constants, API contracts, and data structures shared across the extension, API, and web application.

---

# Architecture Principles

## 1. Browser bookmark IDs are not globally valid

Never treat Chrome or Firefox bookmark IDs as globally unique.

Each browser maintains its own local bookmark identifiers.

The synchronization system must maintain globally unique identifiers.

Use a model similar to:

```text
global bookmark ID
        │
        ├── Chrome local ID
        ├── Firefox local ID
        └── Edge local ID
```

The global identity must remain stable when a bookmark moves between devices or browsers.

---

## 2. Model synchronization as operations

Do not rely exclusively on replacing the entire bookmark tree whenever something changes.

Represent changes as operations.

Examples:

```text
CREATE
UPDATE
MOVE
DELETE
```

An operation should contain enough information to reproduce the change on another device.

A conceptual operation:

```ts
{
  operationId: string;
  deviceId: string;
  userId: string;
  entityId: string;
  type: "CREATE" | "UPDATE" | "MOVE" | "DELETE";
  payload: unknown;
  timestamp: number;
}
```

The final schema may differ, but the underlying principle should remain.

---

## 3. Synchronization must be idempotent

Applying the same operation twice must not corrupt the bookmark tree.

Every operation must therefore have a globally unique identifier.

The server must safely handle retries.

Example:

```text
client sends operation
        ↓
network timeout
        ↓
client retries
        ↓
server recognizes operationId
        ↓
operation is not applied twice
```

---

## 4. Expect offline operation

Browsers can be offline.

The extension should maintain a local queue of pending operations.

Conceptually:

```text
Local bookmark change
        ↓
Create operation
        ↓
Local pending queue
        ↓
Network available
        ↓
Upload operation
        ↓
Server acknowledgement
        ↓
Remove from pending queue
```

Never assume continuous connectivity.

---

## 5. Synchronization must be deterministic

If two devices modify the same bookmark concurrently, the final state must be deterministic.

The initial implementation may use a clearly defined last-write-wins strategy, provided that:

* timestamps are handled consistently;
* operations are ordered deterministically;
* deletes are not accidentally resurrected;
* concurrent moves do not corrupt the tree.

Do not implement vague or implicit conflict behavior.

Document the conflict strategy.

---

# Bookmark Tree Requirements

The system must support at minimum:

```text
Bookmark folders
Bookmarks
Bookmark title
Bookmark URL
Bookmark ordering
Bookmark parent
Nested folders
Creation
Updates
Moves
Deletion
```

The implementation should correctly represent browser-generated special/root folders.

Do not assume all browsers expose exactly the same root structure.

Browser-specific behavior should live in adapters rather than being scattered throughout the synchronization engine.

---

# Security Requirements

Security and privacy are important.

Never:

* commit API keys;
* commit database credentials;
* commit authentication secrets;
* place secrets inside the extension bundle;
* expose server-only environment variables to the browser.

Use environment variables and appropriate Cloudflare/Neon secrets.

The extension must never receive database credentials.

The browser communicates with the API, not directly with PostgreSQL.

---

# Authentication

The system needs user and device identity.

At minimum distinguish:

```text
User
Device
Browser installation
```

A user can have multiple devices:

```text
User
├── Chrome Windows
├── Firefox Ubuntu
├── Chrome macOS
└── Brave Linux
```

Each extension installation should receive a stable device identity.

Do not use a browser's local bookmark ID as its device identity.

Authentication implementation should remain modular so the project can use a managed provider later without rewriting the synchronization engine.

---

# Database Guidelines

Use PostgreSQL through Neon.

Use Drizzle ORM.

Do not write raw SQL throughout the application when the operation can reasonably be represented using Drizzle.

Every schema change must have a migration.

The database should eventually contain concepts similar to:

```text
users
devices
bookmarks
bookmark_locations
sync_operations
sync_cursors
```

The exact schema is an implementation decision and should be designed before substantial synchronization code is written.

Use appropriate indexes for:

* user ID
* device ID
* global bookmark ID
* operation ID
* operation ordering
* parent relationships

---

# API Guidelines

Use Hono.

Keep API routes small and explicit.

Potential API shape:

```text
POST   /auth/...
GET    /devices
POST   /devices
DELETE /devices/:id

POST   /sync/push
GET    /sync/pull

GET    /bookmarks
```

Do not prematurely create dozens of endpoints.

The sync protocol should be the primary API.

Validate incoming data using a runtime schema validator such as Zod.

Never trust client-provided data.

---

# Extension Guidelines

The extension should have a background service worker responsible for synchronization.

The extension should:

1. Detect bookmark changes.
2. Translate browser-specific events into global synchronization operations.
3. Store pending local operations.
4. Push operations to the API.
5. Pull remote operations.
6. Apply remote operations locally.
7. Track synchronization state.
8. Recover gracefully after service worker/browser restarts.

The bookmark event listeners must not trigger infinite synchronization loops.

For example:

```text
Remote operation
      ↓
Apply locally
      ↓
Browser fires bookmark event
      ↓
Event is recognized as sync-generated
      ↓
Do NOT generate another remote operation
```

Implement a reliable mechanism to distinguish locally initiated changes from remote synchronization changes.

---

# Local Storage

Use browser extension storage for local state where appropriate.

Possible state:

```text
deviceId
authentication/session information
lastSyncCursor
pendingOperations
bookmark identity mappings
sync metadata
```

Do not store large or unnecessary duplicated copies of the server database in extension storage.

---

# Type Safety

Use strict TypeScript.

Avoid:

```ts
any
```

unless absolutely necessary.

Prefer:

```ts
unknown
```

plus runtime validation.

Shared types should live in:

```text
packages/shared
```

API request/response schemas should have a single source of truth whenever practical.

---

# Code Quality

Prioritize:

* simple architecture;
* strong types;
* small modules;
* explicit error handling;
* testability;
* deterministic synchronization;
* readable code.

Do not over-engineer the first version.

Avoid introducing:

* microservices;
* message queues;
* Redis;
* Kafka;
* Kubernetes;
* unnecessary realtime infrastructure;
* unnecessary abstractions.

The MVP should remain small.

---

# Testing

Tests are especially important for synchronization.

At minimum, test:

### Bookmark operations

```text
create bookmark
update bookmark
move bookmark
delete bookmark
create folder
move folder
nested folders
```

### Synchronization

```text
push operation
pull operation
retry operation
duplicate operation
offline queue
concurrent edits
delete vs update
move vs move
```

### Browser behavior

Test against:

```text
Chrome/Chromium
Firefox
```

where practical.

The sync engine should have unit tests independent of the browser APIs.

---

# Development Workflow

Before implementing a major feature:

1. Understand the current architecture.
2. Check existing shared types and database schema.
3. Make the smallest change that solves the requirement.
4. Add or update tests.
5. Run type checking.
6. Run tests.
7. Update documentation if behavior or architecture changes.

Do not rewrite working systems without justification.

---

# Environment Variables

Never commit `.env` files containing secrets.

Provide:

```text
.env.example
```

with placeholders.

Environment names should be clearly divided between:

```text
client-safe
server-only
```

Never expose Neon credentials to the extension or web client.

---

# Deployment

Preferred deployment:

```text
Extension:
Browser Web Stores / local development

API:
Cloudflare Workers

Web:
Cloudflare Pages

Database:
Neon PostgreSQL
```

The application must be deployable independently.

---

# Cost Philosophy

The initial system should target approximately $0 operating cost for personal use.

Prefer free tiers.

Avoid architecture that requires:

* paid managed queues;
* paid Redis;
* paid realtime infrastructure;
* unnecessary server instances.

Do not compromise correctness or security merely to avoid a tiny cost, but avoid unnecessary infrastructure.

---

# Product Direction

The long-term product may support:

```text
cross-browser bookmark sync
multi-device sync
bookmark search
bookmark management
sync history
device management
backup/export
restore
privacy-focused synchronization
end-to-end encryption
open-source self-hosting
```

Do not implement all of these initially.

The first milestone is reliable synchronization of bookmarks and folders across two browsers.

---

# Agent Behavior

When working on this repository:

* Read `AGENTS.md` before making architectural changes.
* Inspect existing code before creating new modules.
* Reuse existing utilities and shared types.
* Do not create duplicate implementations.
* Do not silently change the selected stack.
* Do not add dependencies without a clear reason.
* Prefer incremental implementation.
* Explain meaningful architectural changes in code comments or documentation.
* Never fake successful tests or deployment.
* If something cannot be verified, explicitly state that it could not be verified.

The synchronization engine is the most critical component of the project. Optimize for correctness before visual polish.

