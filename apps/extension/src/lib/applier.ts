import { browser } from "#imports";
import {
  applyOperation,
  type OperationEffect,
  type Tree,
  type TreeNode,
} from "@syncer/sync";
import { isRootId, newId, type CreatePayload, type SyncOperation } from "@syncer/shared";
import { trackAppliedBrowserIds } from "./loop-guard";
import {
  updateState,
  saveState,
  MAX_DEFERRED_ATTEMPTS,
  type SyncState,
} from "./storage";
import { kindOf as classifyNode } from "./tree-mirror";

class DependencyMissing extends Error {}

interface BrowserNodeInfo {
  id: string;
  title: string;
  url?: string;
  children?: BrowserNodeInfo[];
}

function resolveBrowserParent(state: SyncState, parentKey: string): string {
  if (isRootId(parentKey)) {
    const mapped = state.rootMapping[parentKey];
    if (!mapped) throw new DependencyMissing(`root ${parentKey} unresolved`);
    return mapped;
  }
  const mapped = state.idToBrowser[parentKey];
  if (!mapped) throw new DependencyMissing(`parent ${parentKey} unmapped`);
  return mapped;
}

async function childCount(parentId: string): Promise<number> {
  const children = await browser.bookmarks.getChildren(parentId);
  return (children as unknown as BrowserNodeInfo[]).length;
}

/**
 * Finds an existing, unmapped local node that is indistinguishable from the
 * incoming remote entity (same kind, title, url, same resolved parent).
 * Binding such nodes instead of creating copies is what keeps a second
 * browser from duplicating its own pre-existing bookmarks on first sync.
 */
async function findMatchingUnmappedChild(
  state: SyncState,
  browserParentId: string,
  node: TreeNode,
): Promise<BrowserNodeInfo | null> {
  const children = (await browser.bookmarks.getChildren(browserParentId)) as unknown as BrowserNodeInfo[];
  for (const child of children) {
    if (state.browserToId[child.id]) continue;
    if (classifyNode(child) === "separator") continue;
    const childKind = classifyNode(child) === "folder" ? "folder" : "bookmark";
    if (childKind !== node.kind) continue;
    if (child.title !== node.title) continue;
    if (node.kind === "bookmark" && (child.url ?? null) !== node.url) continue;
    return child;
  }
  return null;
}

async function createEffect(
  state: SyncState,
  node: TreeNode,
): Promise<void> {
  const browserParentId = resolveBrowserParent(state, node.parentId ?? "");

  const match = await findMatchingUnmappedChild(state, browserParentId, node);
  if (match) {
    // Adopt the identical local node instead of creating a duplicate.
    trackAppliedBrowserIds([match.id]);
    state.idToBrowser[node.id] = match.id;
    state.browserToId[match.id] = node.id;
    return;
  }

  const index = Math.min(node.position, await childCount(browserParentId));
  const created = await browser.bookmarks.create({
    parentId: browserParentId,
    title: node.title,
    ...(node.kind === "bookmark" && node.url ? { url: node.url } : {}),
    index,
  });
  trackAppliedBrowserIds([created.id]);
  state.idToBrowser[node.id] = created.id;
  state.browserToId[created.id] = node.id;
}async function updateEffect(
  state: SyncState,
  effect: Extract<OperationEffect, { type: "update" }>,
  tree: Tree,
): Promise<void> {
  const browserId = state.idToBrowser[effect.nodeId];
  if (!browserId) throw new DependencyMissing(`entity ${effect.nodeId} unmapped`);
  const node = tree.get(effect.nodeId);
  const changes: { title?: string; url?: string } = {};
  if (effect.title !== undefined) changes.title = effect.title;
  if (effect.url !== undefined && node?.kind === "bookmark") changes.url = effect.url ?? "";
  if (Object.keys(changes).length === 0) return;
  await browser.bookmarks.update(browserId, changes);
}

async function moveEffect(
  state: SyncState,
  effect: Extract<OperationEffect, { type: "move" }>,
): Promise<void> {
  const browserId = state.idToBrowser[effect.nodeId];
  if (!browserId) throw new DependencyMissing(`entity ${effect.nodeId} unmapped`);
  const browserParentId = resolveBrowserParent(state, effect.parentId);

  // Browsers apply the index after removing the node from its current slot,
  // so when reordering within the same parent the count must exclude it.
  const children = (await browser.bookmarks.getChildren(browserParentId)) as unknown as BrowserNodeInfo[];
  const sameParent = children.some((child) => child.id === browserId);
  const base = children.length - (sameParent ? 1 : 0);
  const index = Math.min(effect.position, base);
  await browser.bookmarks.move(browserId, { parentId: browserParentId, index });
  trackAppliedBrowserIds([browserId]);
}

async function deleteEffect(
  state: SyncState,
  effect: Extract<OperationEffect, { type: "delete" }>,
): Promise<void> {
  const browserId = state.idToBrowser[effect.nodeId];
  if (!browserId) {
    // Unknown locally (e.g. tombstone for an entity this device never saw).
    return;
  }
  trackAppliedBrowserIds([browserId]);

  const removedGlobals: string[] = [effect.nodeId];
  try {
    const subtree = await browser.bookmarks.getSubTree(browserId);
    const root = subtree[0] as unknown as BrowserNodeInfo | undefined;
    if (root) {
      const walk = (node: BrowserNodeInfo): void => {
        const globalId = state.browserToId[node.id];
        if (globalId && globalId !== effect.nodeId) removedGlobals.push(globalId);
        for (const child of node.children ?? []) walk(child);
      };
      for (const child of root.children ?? []) walk(child);
    }
  } catch {
    // Subtree unreadable; fall back to removing only the mapped root.
  }

  try {
    await browser.bookmarks.removeTree(browserId);
  } catch {
    try {
      await browser.bookmarks.remove(browserId);
    } catch (error) {
      console.debug("delete effect ignored:", String(error));
    }
  }

  for (const globalId of removedGlobals) {
    const local = state.idToBrowser[globalId];
    if (local) {
      delete state.browserToId[local];
      delete state.idToBrowser[globalId];
    }
  }
}

/**
 * Applies one remote operation to the browser through the engine.
 * Returns "applied", "noop", or "deferred" (dependencies not yet visible).
 */
export async function applyRemoteOperation(
  state: SyncState,
  tree: Tree,
  op: SyncOperation,
): Promise<"applied" | "noop" | "deferred"> {
  const result = applyOperation(tree, op);

  if (result.status === "deferred") {
    return "deferred";
  }
  if (result.status === "noop") {
    return "noop";
  }

  try {
    for (const effect of result.effects) {
      switch (effect.type) {
        case "create":
          await createEffect(state, effect.node);
          break;
        case "update":
          await updateEffect(state, effect, result.tree);
          break;
        case "move":
          await moveEffect(state, effect);
          break;
        case "delete":
          await deleteEffect(state, effect);
          break;
      }
    }
  } catch (error) {
    if (error instanceof DependencyMissing) {
      return "deferred";
    }
    throw error;
  }
  return "applied";
}

export interface AdoptionResult {
  adoptedCount: number;
}

/**
 * Assigns global identities to existing browser bookmarks and enqueues
 * CREATE operations for them (parents first), so a fresh installation
 * uploads its pre-existing bookmarks instead of duplicating or deleting them.
 */
export async function adoptExistingBookmarks(userId: string, deviceId: string): Promise<AdoptionResult> {
  const state = await updateState(() => {});
  const fullTree = (await browser.bookmarks.getTree()) as unknown as Array<
    BrowserNodeInfo & { children?: BrowserNodeInfo[] }
  >;
  const rootNode = fullTree[0];
  if (!rootNode?.children) return { adoptedCount: 0 };

  const timestamp = Date.now();
  let adoptedCount = 0;

  async function visitChildren(children: BrowserNodeInfo[], parentKey: string): Promise<void> {
    let index = 0;
    for (const child of children) {
      const kind = classifyNode(child);
      if (kind === "separator") continue;
      let globalId = state.browserToId[child.id];
      const isMapped = Boolean(globalId);

      if (!isMapped) {
        globalId = newId();
        state.idToBrowser[globalId] = child.id;
        state.browserToId[child.id] = globalId;
        adoptedCount += 1;
        const payload: CreatePayload =
          kind === "folder"
            ? { kind: "folder", parentId: parentKey, title: child.title, position: index }
            : { kind: "bookmark", parentId: parentKey, title: child.title, url: child.url ?? "about:blank", position: index };
        state.pendingOps.push({
          operationId: newId(),
          userId,
          deviceId,
          entityId: globalId!,
          type: "CREATE",
          payload,
          timestamp,
        });
      }

      if (child.children) {
        await visitChildren(child.children, globalId!);
      }
      index += 1;
    }
  }

  for (const [canonicalRoot, browserRootId] of Object.entries(state.rootMapping)) {
    if (!browserRootId) continue;
    const rootChildren = await browser.bookmarks.getChildren(browserRootId);
    await visitChildren(rootChildren as unknown as BrowserNodeInfo[], canonicalRoot);
  }

  await saveState(state);
  return { adoptedCount };
}

export function deferredLimitReached(attempts: number): boolean {
  return attempts >= MAX_DEFERRED_ATTEMPTS;
}
