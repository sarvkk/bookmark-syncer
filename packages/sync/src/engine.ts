import type { SyncOperation } from "@syncer/shared";
import {
  clampPosition,
  collectSubtreeIds,
  isDescendant,
  getLiveChildren,
  type Tree,
  type TreeNode,
} from "./tree";

export type OperationEffect =
  | { type: "create"; node: TreeNode }
  | { type: "update"; nodeId: string; title?: string; url?: string | null }
  | { type: "move"; nodeId: string; parentId: string; position: number }
  | { type: "delete"; nodeId: string };

export type ApplyStatus = "applied" | "noop" | "deferred";

export interface ApplyResult {
  status: ApplyStatus;
  reason?:
    | "duplicate"
    | "tombstoned"
    | "parent-deleted"
    | "parent-missing"
    | "entity-missing"
    | "cycle"
    | "missing";
  effects: OperationEffect[];
  tree: Tree;
}

/**
 * Applies one operation to the in-memory tree.
 *
 * Conflict strategy (documented in docs/architecture.md):
 *
 * - Operations are applied in server-assigned sequence order. Every device
 *   replays the identical total order, so the last operation in sequence
 *   order wins ("last-arrival-wins"). This is a deterministic LWW variant.
 * - Deletes are tombstones. UPDATE/MOVE/CREATE on a tombstoned entity are
 *   no-ops; deleted entities are never resurrected.
 * - DELETE cascades to all descendants (folder deletion).
 * - Duplicate operations converge to the same state (idempotent).
 * - Operations whose parent/entity has not been seen yet return "deferred"
 *   and must be retried by the caller once dependencies arrive.
 *
 * The input tree is mutated in place and also returned for convenience.
 */
export function applyOperation(tree: Tree, op: SyncOperation): ApplyResult {
  switch (op.type) {
    case "CREATE":
      return applyCreate(tree, op);
    case "UPDATE":
      return applyUpdate(tree, op);
    case "MOVE":
      return applyMove(tree, op);
    case "DELETE":
      return applyDelete(tree, op);
  }
}

function applyCreate(tree: Tree, op: Extract<SyncOperation, { type: "CREATE" }>): ApplyResult {
  const existing = tree.get(op.entityId);
  if (existing) {
    if (existing.deleted) {
      return { status: "noop", reason: "tombstoned", effects: [], tree };
    }
    return { status: "noop", reason: "duplicate", effects: [], tree };
  }

  const parent = tree.get(op.payload.parentId);
  if (!parent || parent.deleted) {
    if (!parent) {
      return { status: "deferred", reason: "parent-missing", effects: [], tree };
    }
    return { status: "noop", reason: "parent-deleted", effects: [], tree };
  }

  const siblings = getLiveChildren(tree, parent.id);
  const node: TreeNode = {
    id: op.entityId,
    kind: op.payload.kind,
    parentId: parent.id,
    title: op.payload.title,
    url: op.payload.url ?? null,
    position: clampPosition(op.payload.position, siblings.length),
    deleted: false,
  };
  tree.set(node.id, node);

  shiftSiblingsAt(tree, parent.id, node.id);
  return { status: "applied", effects: [{ type: "create", node }], tree };
}

function applyUpdate(tree: Tree, op: Extract<SyncOperation, { type: "UPDATE" }>): ApplyResult {
  const node = tree.get(op.entityId);
  if (!node) {
    return { status: "deferred", reason: "entity-missing", effects: [], tree };
  }
  if (node.deleted) {
    return { status: "noop", reason: "tombstoned", effects: [], tree };
  }

  const effect: OperationEffect = { type: "update", nodeId: node.id };
  if (op.payload.title !== undefined) {
    node.title = op.payload.title;
    effect.title = op.payload.title;
  }
  if (op.payload.url !== undefined && node.kind === "bookmark") {
    node.url = op.payload.url;
    effect.url = op.payload.url;
  }
  return { status: "applied", effects: [effect], tree };
}

function applyMove(tree: Tree, op: Extract<SyncOperation, { type: "MOVE" }>): ApplyResult {
  const node = tree.get(op.entityId);
  if (!node) {
    return { status: "deferred", reason: "entity-missing", effects: [], tree };
  }
  if (node.deleted) {
    return { status: "noop", reason: "tombstoned", effects: [], tree };
  }

  const target = tree.get(op.payload.parentId);
  if (!target) {
    return { status: "deferred", reason: "parent-missing", effects: [], tree };
  }
  if (target.deleted) {
    return { status: "noop", reason: "parent-deleted", effects: [], tree };
  }
  if (node.kind === "folder" && isDescendant(tree, node.id, target.id)) {
    return { status: "noop", reason: "cycle", effects: [], tree };
  }

  const oldParentId = node.parentId;
  node.parentId = target.id;
  node.position = op.payload.position;

  if (oldParentId !== target.id) {
    compactSiblingPositions(tree, oldParentId);
  }
  shiftSiblingsAt(tree, target.id, node.id);

  return {
    status: "applied",
    effects: [
      { type: "move", nodeId: node.id, parentId: target.id, position: node.position },
    ],
    tree,
  };
}

function applyDelete(tree: Tree, op: Extract<SyncOperation, { type: "DELETE" }>): ApplyResult {
  const node = tree.get(op.entityId);
  if (!node) {
    // The entity is unknown locally (e.g. its CREATE was lost or not yet
    // replayed). Persist a tombstone anyway so a later CREATE cannot
    // resurrect it on this device; otherwise devices would diverge.
    tree.set(op.entityId, {
      id: op.entityId,
      kind: "bookmark",
      parentId: null,
      title: "",
      url: null,
      position: 0,
      deleted: true,
    });
    return { status: "noop", reason: "missing", effects: [], tree };
  }
  if (node.deleted) {
    return { status: "noop", reason: "tombstoned", effects: [], tree };
  }

  const subtreeIds = collectSubtreeIds(tree, node.id);
  for (const id of subtreeIds) {
    const member = tree.get(id)!;
    member.deleted = true;
  }
  compactSiblingPositions(tree, node.parentId);

  return {
    status: "applied",
    effects: [{ type: "delete", nodeId: node.id }],
    tree,
  };
}

/**
 * Positions are dense indices (0..n-1) among live siblings after every
 * applied operation. Placing a node at an index shifts later siblings by one.
 * Deterministic because every device replays the same operations in the same
 * order; adapters translate these positions into concrete browser indexes.
 */
function shiftSiblingsAt(tree: Tree, parentId: string, nodeId: string): void {
  const node = tree.get(nodeId)!;
  const siblings = getLiveChildren(tree, parentId).filter((c) => c.id !== nodeId);
  node.position = clampPosition(node.position, siblings.length);
  for (const sibling of siblings) {
    if (sibling.position >= node.position) {
      sibling.position += 1;
    }
  }
}

function compactSiblingPositions(tree: Tree, parentId: string | null): void {
  if (!parentId) return;
  const children = getLiveChildren(tree, parentId);
  children.forEach((child, index) => {
    child.position = index;
  });
}
