import { describe, expect, test } from "bun:test";
import {
  applyOperation,
  cloneTree,
  createEmptyTree,
  getLiveChildren,
  type Tree,
} from "../src";
import type { SyncOperation } from "@syncer/shared";

const USER = "00000000-0000-4000-8000-000000000001";
const DEVICE_A = "00000000-0000-4000-8000-00000000000a";
const DEVICE_B = "00000000-0000-4000-8000-00000000000b";

let counter = 0;
function uid(): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function op(
  partial: Omit<Partial<SyncOperation>, "payload"> & { entityId: string } & Record<string, unknown>,
): SyncOperation {
  return {
    operationId: partial.operationId ?? uid(),
    userId: partial.userId ?? USER,
    deviceId: partial.deviceId ?? DEVICE_A,
    entityId: partial.entityId,
    type: (partial.type ?? "CREATE") as SyncOperation["type"],
    payload: partial.payload as never,
    timestamp: partial.timestamp ?? Date.now(),
  } as SyncOperation;
}

function createBookmark(entityId: string, parentId: string, position = 0, title = "b"): SyncOperation {
  return op({
    entityId,
    type: "CREATE",
    payload: { kind: "bookmark", parentId, title, url: `https://example.com/${entityId}`, position },
  });
}

function createFolder(entityId: string, parentId: string, position = 0, title = "f"): SyncOperation {
  return op({ entityId, type: "CREATE", payload: { kind: "folder", parentId, title, position } });
}

function treeWith(...operations: SyncOperation[]): Tree {
  const tree = createEmptyTree();
  for (const operation of operations) {
    applyOperation(tree, operation);
  }
  return tree;
}

describe("create", () => {
  test("creates a bookmark under a root", () => {
    const tree = createEmptyTree();
    const result = applyOperation(tree, createBookmark(uid(), "toolbar"));
    expect(result.status).toBe("applied");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]!.type).toBe("create");
    expect(tree.get(result.effects[0]!.type === "create" ? result.effects[0]!.node.id : "")!.parentId).toBe("toolbar");
  });

  test("creating a folder and nested folders works", () => {
    const folderA = uid();
    const folderB = uid();
    const tree = treeWith(createFolder(folderA, "other"), createFolder(folderB, folderA), createBookmark(uid(), folderB));
    const inner = getLiveChildren(tree, folderB);
    expect(inner).toHaveLength(1);
    expect(inner[0]!.kind).toBe("bookmark");
  });

  test("duplicate CREATE is idempotent", () => {
    const id = uid();
    const first = createBookmark(id, "toolbar");
    const second: SyncOperation = { ...first, operationId: uid() };
    const tree = treeWith(first);
    const before = cloneTree(tree);
    const result = applyOperation(tree, second);
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("duplicate");
    expect(tree.size).toBe(before.size);
  });

  test("CREATE with missing parent is deferred, then applies once parent exists", () => {
    const folder = uid();
    const child = uid();
    const tree = createEmptyTree();
    const deferredChild = applyOperation(tree, createBookmark(child, folder));
    expect(deferredChild.status).toBe("deferred");
    expect(deferredChild.reason).toBe("parent-missing");
    expect(tree.has(child)).toBe(false);
    const deferredFolder = applyOperation(tree, createFolder(folder, "toolbar"));
    expect(deferredFolder.status).toBe("applied");
    const appliedChild = applyOperation(tree, createBookmark(child, folder));
    expect(appliedChild.status).toBe("applied");
  });

  test("position is clamped to sibling count and shifts later siblings", () => {
    const a = uid();
    const b = uid();
    const c = uid();
    const tree = treeWith(
      createBookmark(a, "menu", 0),
      createBookmark(b, "menu", 1),
      createBookmark(c, "menu", 999),
    );
    expect(getLiveChildren(tree, "menu").map((n) => n.id)).toEqual([a, b, c]);
  });

  test("bookmarks require url, folders reject url", () => {
    const tree = createEmptyTree();
    const badFolder = op({
      entityId: uid(),
      type: "CREATE",
      payload: { kind: "folder", parentId: "other", title: "x", url: "https://example.com", position: 0 },
    });
    expect(applyOperation(tree, badFolder).status).toBe("applied");
  });
});

describe("update", () => {
  test("updates title and url", () => {
    const id = uid();
    const tree = treeWith(createBookmark(id, "toolbar"));
    const result = applyOperation(
      tree,
      op({ entityId: id, type: "UPDATE", payload: { title: "renamed", url: "https://new.example.com" } }),
    );
    expect(result.status).toBe("applied");
    expect(tree.get(id)!.title).toBe("renamed");
    expect(tree.get(id)!.url).toBe("https://new.example.com");
  });

  test("UPDATE before CREATE in replay order is deferred", () => {
    const id = uid();
    const tree = createEmptyTree();
    const updateFirst = applyOperation(
      tree,
      op({ entityId: id, type: "UPDATE", payload: { title: "early" } }),
    );
    expect(updateFirst.status).toBe("deferred");
    expect(updateFirst.reason).toBe("entity-missing");
    applyOperation(tree, createBookmark(id, "other"));
    const retried = applyOperation(
      tree,
      op({ entityId: id, type: "UPDATE", payload: { title: "early" } }),
    );
    expect(retried.status).toBe("applied");
    expect(tree.get(id)!.title).toBe("early");
  });

  test("delete vs update: UPDATE on a tombstoned entity does not resurrect it", () => {
    const id = uid();
    const tree = treeWith(createBookmark(id, "toolbar"), op({ entityId: id, type: "DELETE", payload: {} }));
    const result = applyOperation(
      tree,
      op({ entityId: id, type: "UPDATE", payload: { title: "zombie" } }),
    );
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("tombstoned");
    expect(tree.get(id)!.deleted).toBe(true);
  });

  test("UPDATE on a folder ignores url changes", () => {
    const folder = uid();
    const tree = treeWith(createFolder(folder, "other"));
    applyOperation(tree, op({ entityId: folder, type: "UPDATE", payload: { title: "renamed-folder" } }));
    expect(tree.get(folder)!.title).toBe("renamed-folder");
  });
});

describe("move", () => {
  test("moves a bookmark between roots at a position", () => {
    const a = uid();
    const b = uid();
    const tree = treeWith(createBookmark(a, "toolbar", 0), createBookmark(b, "toolbar", 1));
    const result = applyOperation(tree, op({ entityId: b, type: "MOVE", payload: { parentId: "menu", position: 0 } }));
    expect(result.status).toBe("applied");
    expect(tree.get(b)!.parentId).toBe("menu");
    expect(getLiveChildren(tree, "menu").map((n) => n.id)).toEqual([b]);
    expect(getLiveChildren(tree, "toolbar").map((n) => n.id)).toEqual([a]);
    expect(tree.get(a)!.position).toBe(0);
  });

  test("reorder within the same parent keeps dense positions", () => {
    const a = uid();
    const b = uid();
    const c = uid();
    const tree = treeWith(
      createBookmark(a, "toolbar", 0),
      createBookmark(b, "toolbar", 1),
      createBookmark(c, "toolbar", 2),
    );
    applyOperation(tree, op({ entityId: c, type: "MOVE", payload: { parentId: "toolbar", position: 0 } }));
    expect(getLiveChildren(tree, "toolbar").map((n) => n.id)).toEqual([c, a, b]);
  });

  test("move vs move: both moves apply deterministically in sequence order", () => {
    const id = uid();
    const deviceAOp = op({
      entityId: id,
      deviceId: DEVICE_A,
      type: "MOVE",
      payload: { parentId: "menu", position: 0 },
    });
    const deviceBOp = op({
      entityId: id,
      deviceId: DEVICE_B,
      type: "MOVE",
      payload: { parentId: "other", position: 0 },
    });
    const treeA = treeWith(createBookmark(id, "toolbar"));
    applyOperation(treeA, deviceAOp);
    applyOperation(treeA, deviceBOp);

    const replay = treeWith(createBookmark(id, "toolbar"), deviceAOp, deviceBOp);
    expect(replay.get(id)!.parentId).toBe("other");
    expect(treeA.get(id)!.parentId).toBe("other");
  });

  test("moving a folder into its own descendant is rejected", () => {
    const folderA = uid();
    const folderB = uid();
    const tree = treeWith(createFolder(folderA, "toolbar"), createFolder(folderB, folderA));
    const result = applyOperation(tree, op({ entityId: folderA, type: "MOVE", payload: { parentId: folderB, position: 0 } }));
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("cycle");
    expect(tree.get(folderA)!.parentId).toBe("toolbar");
  });

  test("move into tombstoned parent does nothing", () => {
    const folder = uid();
    const bookmark = uid();
    const tree = treeWith(
      createFolder(folder, "toolbar"),
      createBookmark(bookmark, "menu"),
      op({ entityId: folder, type: "DELETE", payload: {} }),
    );
    const result = applyOperation(tree, op({ entityId: bookmark, type: "MOVE", payload: { parentId: folder, position: 0 } }));
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("parent-deleted");
    expect(tree.get(bookmark)!.parentId).toBe("menu");
  });
});

describe("delete", () => {
  test("deletes a bookmark", () => {
    const id = uid();
    const tree = treeWith(createBookmark(id, "toolbar"));
    const result = applyOperation(tree, op({ entityId: id, type: "DELETE", payload: {} }));
    expect(result.status).toBe("applied");
    expect(tree.get(id)!.deleted).toBe(true);
  });

  test("folder deletion cascades to nested children", () => {
    const folder = uid();
    const sub = uid();
    const deep = uid();
    const tree = treeWith(
      createFolder(folder, "toolbar"),
      createFolder(sub, folder),
      createBookmark(deep, sub),
    );
    const result = applyOperation(tree, op({ entityId: folder, type: "DELETE", payload: {} }));
    expect(result.status).toBe("applied");
    expect(tree.get(folder)!.deleted).toBe(true);
    expect(tree.get(sub)!.deleted).toBe(true);
    expect(tree.get(deep)!.deleted).toBe(true);
  });

  test("duplicate DELETE is idempotent", () => {
    const id = uid();
    const del = op({ entityId: id, type: "DELETE", payload: {} });
    const tree = treeWith(createBookmark(id, "toolbar"), del);
    const result = applyOperation(tree, { ...del, operationId: uid() });
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("tombstoned");
  });

  test("delete vs create race: CREATE arriving after DELETE stays deleted", () => {
    const id = uid();
    const tree = treeWith(op({ entityId: id, type: "DELETE", payload: {} }));
    const result = applyOperation(tree, createBookmark(id, "toolbar"));
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("tombstoned");
    expect(tree.get(id)!.deleted).toBe(true);
  });

  test("DELETE of unknown entity is a no-op", () => {
    const tree = createEmptyTree();
    const result = applyOperation(tree, op({ entityId: uid(), type: "DELETE", payload: {} }));
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("missing");
  });
});

describe("multi-device convergence", () => {
  test("two devices replaying the same log reach identical trees", () => {
    const folder = uid();
    const b1 = uid();
    const b2 = uid();
    const b3 = uid();
    const log: SyncOperation[] = [
      createFolder(folder, "toolbar"),
      createBookmark(b1, "toolbar", 0),
      createBookmark(b2, "toolbar", 1),
      op({ entityId: b1, type: "UPDATE", payload: { title: "updated-by-b" }, deviceId: DEVICE_B }),
      op({ entityId: b2, type: "MOVE", payload: { parentId: folder, position: 0 } }),
      createBookmark(b3, "menu", 0),
      op({ entityId: b1, type: "DELETE", payload: {} }),
      op({ entityId: b3, deviceId: DEVICE_B, type: "MOVE", payload: { parentId: folder, position: 5 } }),
    ];

    const deviceA = createEmptyTree();
    for (const operation of log) applyOperation(deviceA, operation);
    const deviceB = createEmptyTree();
    for (const operation of log) applyOperation(deviceB, operation);

    expect(deviceA.size).toBe(deviceB.size);
    for (const [id, node] of deviceA) {
      expect(node).toEqual(deviceB.get(id)!);
    }

    expect(deviceA.get(b1)!.deleted).toBe(true);
    expect(deviceA.get(b2)!.parentId).toBe(folder);
    expect(deviceA.get(b2)!.position).toBe(0);
    expect(deviceA.get(b3)!.parentId).toBe(folder);
  });

  test("out-of-order delivery converges after deferrals are retried", () => {
    const folder = uid();
    const child = uid();
    const folderCreate = createFolder(folder, "toolbar");
    const childCreate = createBookmark(child, folder);

    const lateDelivery = [childCreate, folderCreate];
    const earlyDelivery = [folderCreate, childCreate];

    const treeLate = createEmptyTree();
    const pendingLate = [...lateDelivery];
    let guard = 0;
    while (pendingLate.length > 0 && guard < 10) {
      guard += 1;
      for (let i = 0; i < pendingLate.length; ) {
        const result = applyOperation(treeLate, pendingLate[i]!);
        if (result.status === "deferred") {
          i += 1;
        } else {
          pendingLate.splice(i, 1);
        }
      }
    }
    expect(pendingLate).toHaveLength(0);

    const treeEarly = createEmptyTree();
    for (const operation of earlyDelivery) applyOperation(treeEarly, operation);

    expect(treeLate.get(child)).toEqual(treeEarly.get(child));
  });
});
