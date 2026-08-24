# Architecture

This document explains the synchronization design: identity, the operation
model, conflict handling, loop prevention, and known limitations of the first
milestone.

## 1. Identifier model

Browser bookmark IDs are **profile-local** and never used as global identity.

```text
global entity ID (uuid)
        ├── Chromium local node id   (extension storage mapping)
        ├── Firefox local node id    (extension storage mapping)
        └── Zen local node id        (same Firefox mapping)
```

| Identifier | Scope | Lifetime |
| --- | --- | --- |
| `userId` | account | forever |
| `deviceId` | one extension installation | until device removed |
| `entityId` | one bookmark/folder across all browsers | forever (tombstoned on delete) |
| `operationId` | one synchronization operation | forever (log + idempotency key) |

Root folders are *not* entities because browsers expose different root
structures. The protocol defines three canonical root slots — `toolbar`,
`menu`, `other` — and each adapter resolves them onto real browser nodes:

* **Chromium** (`folderType` when available, title fallback): `toolbar` →
  Bookmarks bar, `other` → Other bookmarks. There is no menu-bar folder, so
  `menu` maps to the bookmarks bar.
* **Firefox/Zen** (stable id suffixes, locale-independent): `toolbar______`
  / `menu________` / `unfiled_____`.

Adapters live in `apps/extension/src/adapters/`. Supporting a new browser
means writing an adapter; nothing else changes.

## 2. Operations

Changes are represented as operations, never as whole-tree replaces:

```ts
{
  operationId,          // uuid, globally unique → idempotency key
  userId, deviceId,
  entityId,             // global bookmark/folder id
  type,                 // CREATE | UPDATE | MOVE | DELETE
  payload,              // discriminated union per type
  timestamp             // client wall clock, informational
}
```

Lifecycle:

```text
local bookmark event
        ↓ loop-guard check (sync-generated? → ignore)
build operation (needs parent/entity mappings)
        ↓ pendingOps queue (browser.storage.local, survives restarts)
push batch → server appends to sync_operations log
        ↓ ack (applied) or duplicate → dequeue
pull ops after lastCursor → apply through engine → browser mutations
```

## 3. Determinism and conflicts

The server assigns each accepted operation a monotonic `seq` at arrival.
Every device replays the same total order via `/sync/pull?cursor=N`, so the
**last operation in server sequence wins** — a well-defined LWW variant that
requires no clock synchronization between devices.

Deterministic engine rules (`packages/sync/src/engine.ts`, unit-tested):

| Case | Behaviour |
| --- | --- |
| duplicate CREATE / DELETE | no-op, converges |
| UPDATE/MOVE on deleted entity | ignored — deletes are tombstones, never resurrected |
| CREATE for tombstoned entity | ignored |
| folder DELETE | cascades to entire subtree |
| concurrent MOVEs | both applied in seq order; final position = later op's request clamped into range |
| move folder into own descendant | rejected (`cycle`) |
| out-of-order arrival | engine returns `deferred`; caller retries once dependencies exist, with a dead-letter cap |
| positions | dense indices over live siblings; insertion shifts later siblings |

Because application is a pure function of `(tree, op)` and the op order is
total and identical everywhere, all replicas converge without clocks.

## 4. Server-side canonical state

The API applies accepted operations to the materialized `bookmarks` table
using the **same engine package** as devices (`apps/api/src/sync-service.ts`),
loading only the required slice of state (parent chain, sibling sets,
subtree). The operation log is authoritative; the table is a derived view
that serves bootstrap and the dashboard.

**Consistency note:** the Neon HTTP driver has no interactive transactions,
so "append to log" and "apply to table" are separate statements. A crash
between them leaves the table stale but the log complete — replay converges,
and pushes acknowledge accordingly. Tightening this into a transaction is a
known follow-up (swap driver or use a proxy).

Idempotency is enforced by a unique index on `sync_operations.operation_id`
with `ON CONFLICT DO NOTHING`; retries receive status `duplicate`.

## 5. Loop prevention

The classic failure:

```text
remote op applied → browser fires event → listener enqueues new op → …∞
```

Mechanism (`apps/extension/src/lib/loop-guard.ts`):

1. All remote application happens inside `applyRemotely()`, which raises an
   in-memory guard for the entire awaited call stack. Bookmark events fired
   during that window are recognized as sync-generated and dropped.
2. Browser-local ids touched by remote application are remembered until the
   next cycle starts (`wasAppliedBySync`), catching late-arriving events.
3. Both checks are **identity-based**, not timing-based: correctness does not
   depend on any timeout value.

Local operations additionally require their parent to be mapped before an
operation is created; unmapped parents are skipped rather than guessed.

## 6. Local state (extension)

Stored in `browser.storage.local` under one key, so the service worker can be
killed at any time:

```text
userId, userToken, deviceId, deviceToken   dev-auth credentials
rootMapping                                canonical slot → browser root id
idToBrowser / browserToId                  global ↔ local identity mapping
lastCursor                                 pull watermark (server seq)
pendingOps / deferredOps                   outgoing queues with retry caps
status, lastSyncAt, lastError              popup display
```

Recovery paths: alarms re-kick the sync every minute; listeners are registered
at service-worker top level; queues persist across restarts.

## 7. Authentication (development-grade, temporary)

`POST /auth/dev/register {email}` returns a long-lived user token with **no
verification**. Devices register with the user token and receive a per-device
token; both are stored hashed server-side. Requests carry
`Authorization: Bearer <deviceToken>` plus `x-user-id`/`x-device-id`, so a
device token only works for its exact user/device pair.

This exists purely to make the first milestone testable end-to-end. Set the
Worker variable `DISABLE_DEV_AUTH=1` to turn the endpoint off before exposing
the deployment publicly; the sync engine takes an opaque authenticated context
and needs no changes when a real provider replaces this scheme.

## 8. Hardening in place

* **Rate limiting** — fixed-window per-IP limiter on `/auth/*` (10/min) and
  `/sync/*` (120/min). In-memory and per-isolate: abuse mitigation rather
  than a hard guarantee.
* **Ownership enforcement** — every pushed operation is checked against a
  cross-user lookup; operations referencing another account's entity IDs are
  rejected (`entity-owned-by-other`) and never enter the log.
* **Identity binding** — device tokens are bound to their exact
  `(userId, deviceId)` pair; mismatches are rejected before any state is read.
* **Input validation** — every operation payload passes Zod schemas at the
  network boundary; malformed batches are rejected wholesale (400).

## 9. Known limitations / roadmap

* No transactions between log append and canonical apply (see §4).
* Pull replays full history from cursor 0 on first sync; fine for personal
  use, snapshot bootstrap is a future optimization.
* No end-to-end encryption yet (roadmap item).
* Dev auth is not production auth (see §7).
* Bookmark separators (Firefox) are ignored rather than synchronized.
* Rate limiter state resets on Worker eviction; move to durable storage if
  strict limits become necessary.

