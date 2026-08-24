import { and, eq, inArray, isNull, max } from "drizzle-orm";
import {
  bookmarks,
  syncOperations,
  type BookmarkRow,
  type Database,
} from "@syncer/db";
import {
  isRootId,
  type PushResult,
  type SyncOperation,
} from "@syncer/shared";
import {
  applyOperation,
  collectSubtreeIds,
  createEmptyTree,
  getLiveChildren,
  type Tree,
  type TreeNode,
} from "@syncer/sync";

interface LoadedState {
  tree: Tree;
  loadedPositions: Map<string, number>;
  touchedParents: Set<string>;
}

function rowToNode(row: BookmarkRow): TreeNode {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.rootId !== null ? row.rootId : row.parentId,
    title: row.title,
    url: row.url,
    position: Number(row.position),
    deleted: row.deletedAt !== null,
  };
}

function putRow(tree: Tree, row: BookmarkRow, state: LoadedState): void {
  if (!tree.has(row.id)) {
    tree.set(row.id, rowToNode(row));
    state.loadedPositions.set(row.id, Number(row.position));
  }
}

async function loadEntityRow(
  db: Database,
  userId: string,
  entityId: string,
): Promise<BookmarkRow | null> {
  const rows = await db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.id, entityId), eq(bookmarks.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadLiveChildrenOf(
  db: Database,
  userId: string,
  parentId: string,
  state: LoadedState,
): Promise<void> {
  const condition = isRootId(parentId)
    ? and(eq(bookmarks.userId, userId), eq(bookmarks.rootId, parentId), isNull(bookmarks.deletedAt))
    : and(eq(bookmarks.userId, userId), eq(bookmarks.parentId, parentId), isNull(bookmarks.deletedAt));
  const rows = await db.select().from(bookmarks).where(condition);
  for (const row of rows) {
    putRow(state.tree, row, state);
  }
  state.touchedParents.add(parentId);
}

async function loadParentChain(
  db: Database,
  userId: string,
  startId: string,
  state: LoadedState,
): Promise<void> {
  let currentId: string | null = isRootId(startId) ? null : startId;
  let depth = 0;
  while (currentId && depth < 100) {
    const row = await loadEntityRow(db, userId, currentId);
    if (!row) break;
    putRow(state.tree, row, state);
    currentId = row.rootId !== null ? null : row.parentId;
    depth += 1;
  }
}

async function loadSubtree(
  db: Database,
  userId: string,
  rootEntityId: string,
  state: LoadedState,
): Promise<void> {
  let frontier = [rootEntityId];
  let depth = 0;
  while (frontier.length > 0 && depth < 500) {
    const rows = await db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, userId),
          inArray(bookmarks.parentId, frontier),
          isNull(bookmarks.deletedAt),
        ),
      );
    frontier = [];
    for (const row of rows) {
      putRow(state.tree, row, state);
      frontier.push(row.id);
    }
    depth += 1;
  }
}

/**
 * Loads the minimal slice of canonical state required to run the engine for
 * `op`: the entity itself (live or tombstoned), its ancestor chain for cycle
 * detection, the target parent plus its live children for position
 * arithmetic, or the full subtree for deletions.
 */
async function buildState(
  db: Database,
  userId: string,
  op: SyncOperation,
): Promise<LoadedState> {
  const state: LoadedState = {
    tree: createEmptyTree(),
    loadedPositions: new Map(),
    touchedParents: new Set(),
  };

  const entity = await loadEntityRow(db, userId, op.entityId);
  if (entity) {
    putRow(state.tree, entity, state);
  }

  if (op.type === "DELETE") {
    if (entity && !entity.deletedAt) {
      await loadSubtree(db, userId, op.entityId, state);
    }
    return state;
  }

  if (op.type === "UPDATE") {
    return state;
  }

  const parentId = op.payload.parentId;
  await loadParentChain(db, userId, parentId, state);
  await loadLiveChildrenOf(db, userId, parentId, state);

  if (op.type === "MOVE" && entity && !entity.deletedAt) {
    const oldParentId = entity.rootId ?? entity.parentId;
    if (oldParentId) {
      await loadLiveChildrenOf(db, userId, oldParentId, state);
    }
  }

  return state;
}

export interface PushOutcome {
  results: PushResult[];
  serverCursor: number;
}

/**
 * Processes a validated batch of operations sequentially:
 *
 * 1. identity + ownership validation (rejections are NOT recorded);
 * 2. append to sync_operations with ON CONFLICT DO NOTHING on operation_id,
 *    making retries idempotent ("duplicate");
 * 3. apply accepted operations to the canonical bookmark table using the
 *    same engine rules devices use, translating effects into row writes.
 *
 * neon-http has no interactive transactions, so steps 2 and 3 are separate
 * statements. The operation log remains authoritative for convergence; the
 * materialized table is eventually consistent under races. See
 * docs/architecture.md ("Consistency notes").
 */
export async function processPush(
  db: Database,
  ctx: { userId: string; deviceId: string },
  operations: SyncOperation[],
): Promise<PushOutcome> {
  const results: PushResult[] = [];

  for (const op of operations) {
    if (op.userId !== ctx.userId || op.deviceId !== ctx.deviceId) {
      results.push({ operationId: op.operationId, status: "rejected", reason: "identity-mismatch" });
      continue;
    }

    const rejection = await validateOwnershipAndParents(db, ctx.userId, op);
    if (rejection !== null) {
      results.push({ operationId: op.operationId, status: "rejected", reason: rejection });
      continue;
    }

    const inserted = await db
      .insert(syncOperations)
      .values({
        operationId: op.operationId,
        userId: op.userId,
        deviceId: op.deviceId,
        entityId: op.entityId,
        type: op.type,
        payload: op.payload,
        clientTimestamp: op.timestamp,
      })
      .onConflictDoNothing({ target: syncOperations.operationId })
      .returning({ seq: syncOperations.seq });

    if (inserted.length === 0) {
      results.push({ operationId: op.operationId, status: "duplicate" });
      continue;
    }

    try {
      await applyToCanonical(db, ctx.userId, op);
      results.push({ operationId: op.operationId, status: "applied" });
    } catch {
      // The operation is durably logged, so pull-based replay converges even
      // if this materialized write failed. Report a soft rejection so the
      // client does not treat it as confirmed.
      results.push({
        operationId: op.operationId,
        status: "rejected",
        reason: "canonical-apply-failed",
      });
    }
  }

  const cursorRows = await db
    .select({ value: max(syncOperations.seq) })
    .from(syncOperations)
    .where(eq(syncOperations.userId, ctx.userId));
  const serverCursor = Number(cursorRows[0]?.value ?? 0);

  return { results, serverCursor };
}

async function loadEntityRowAnyUser(
  db: Database,
  entityId: string,
): Promise<BookmarkRow | null> {
  const rows = await db
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.id, entityId))
    .limit(1);
  return rows[0] ?? null;
}

async function validateOwnershipAndParents(
  db: Database,
  userId: string,
  op: SyncOperation,
): Promise<string | null> {
  // Entity IDs are client-generated UUIDs; reject any operation that
  // references an entity belonging to a different account.
  const foreign = await loadEntityRowAnyUser(db, op.entityId);
  if (foreign && foreign.userId !== userId) {
    return "entity-owned-by-other";
  }

  const entity = await loadEntityRow(db, userId, op.entityId);

  if (op.type === "CREATE") {
    if (!entity) {
      const parentId = op.payload.parentId;
      if (!isRootId(parentId)) {
        const parent = await loadEntityRow(db, userId, parentId);
        if (!parent || parent.kind !== "folder" || parent.deletedAt) {
          return "invalid-parent";
        }
      }
    }
    return null;
  }

  if (op.type === "DELETE") {
    return null;
  }

  if (!entity) {
    return "unknown-entity";
  }

  if (op.type === "MOVE") {
    const parentId = op.payload.parentId;
    if (!isRootId(parentId)) {
      const parent = await loadEntityRow(db, userId, parentId);
      if (!parent || parent.kind !== "folder" || parent.deletedAt) {
        return "invalid-parent";
      }
    }
  }

  return null;
}

async function applyToCanonical(
  db: Database,
  userId: string,
  op: SyncOperation,
): Promise<void> {
  const state = await buildState(db, userId, op);

  const preDeleteSubtree =
    op.type === "DELETE" ? collectSubtreeIds(state.tree, op.entityId) : [];

  const result = applyOperation(state.tree, op);
  if (result.status === "deferred") {
    throw new Error(`canonical apply deferred unexpectedly: ${result.reason}`);
  }
  if (result.status === "noop") {
    if (result.reason === "missing" && op.type === "DELETE") {
      // Unknown entity was deleted before its CREATE reached us: persist a
      // placeholder tombstone so a later CREATE cannot resurrect it
      // (mirrors device-side engine behaviour).
      await db
        .insert(bookmarks)
        .values({
          id: op.entityId,
          userId,
          kind: "bookmark",
          title: "",
          deletedAt: new Date(),
        })
        .onConflictDoNothing({ target: bookmarks.id });
    }
    return;
  }

  const now = new Date();
  for (const effect of result.effects) {
    switch (effect.type) {
      case "create": {
        const node = effect.node;
        const rootId = isRootId(node.parentId ?? "") ? node.parentId! : null;
        await db
          .insert(bookmarks)
          .values({
            id: node.id,
            userId,
            kind: node.kind,
            title: node.title,
            url: node.url,
            rootId,
            parentId: rootId === null ? node.parentId : null,
            position: node.position,
          })
          .onConflictDoNothing({ target: bookmarks.id });
        break;
      }
      case "update": {
        await db
          .update(bookmarks)
          .set({ title: effect.title, url: effect.url, updatedAt: now })
          .where(and(eq(bookmarks.id, effect.nodeId), eq(bookmarks.userId, userId)));
        break;
      }
      case "move": {
        const rootId = isRootId(effect.parentId) ? effect.parentId : null;
        await db
          .update(bookmarks)
          .set({
            rootId,
            parentId: rootId === null ? effect.parentId : null,
            position: effect.position,
            updatedAt: now,
          })
          .where(and(eq(bookmarks.id, effect.nodeId), eq(bookmarks.userId, userId)));
        break;
      }
      case "delete": {
        const ids = preDeleteSubtree.length > 0 ? preDeleteSubtree : [effect.nodeId];
        await db
          .update(bookmarks)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(bookmarks.userId, userId),
              inArray(bookmarks.id, ids),
              isNull(bookmarks.deletedAt),
            ),
          );
        break;
      }
    }
  }

  await resyncPositions(db, userId, state);
}

/**
 * The engine keeps sibling positions dense among live siblings; mirror any
 * position drift for parents whose child lists were involved.
 */
async function resyncPositions(
  db: Database,
  userId: string,
  state: LoadedState,
): Promise<void> {
  for (const parentId of state.touchedParents) {
    const children = getLiveChildren(state.tree, parentId);
    for (const child of children) {
      const before = state.loadedPositions.get(child.id);
      if (before === undefined || before !== child.position) {
        await db
          .update(bookmarks)
          .set({ position: child.position, updatedAt: new Date() })
          .where(and(eq(bookmarks.id, child.id), eq(bookmarks.userId, userId)));
      }
    }
  }
}
