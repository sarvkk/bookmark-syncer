import { browser } from "#imports";
import { createEmptyTree, type Tree } from "@syncer/sync";
import type { SyncState } from "./storage";

interface BrowserBookmarkNode {
  id: string;
  title: string;
  url?: string;
  type?: "bookmark" | "folder" | "separator";
  children?: BrowserBookmarkNode[];
}

export interface MirrorBuildResult {
  tree: Tree;
  mappedBrowserIds: Set<string>;
}

export type NodeKind = "folder" | "bookmark" | "separator";

export function kindOf(node: { url?: string; type?: string }): NodeKind {
  if (node.type === "folder") return "folder";
  if (node.type === "separator") return "separator";
  if (node.type === "bookmark") return "bookmark";
  return node.url === undefined ? "folder" : "bookmark";
}

/**
 * Builds the engine's in-memory tree from the live browser bookmark tree,
 * restricted to nodes that already have a global identity mapping.
 * Positions are dense indices over mapped siblings.
 */
export async function buildMirrorTree(state: SyncState): Promise<MirrorBuildResult> {
  const tree = createEmptyTree();
  const mappedBrowserIds = new Set<string>();

  const fullTree = (await browser.bookmarks.getTree()) as unknown as Array<
    BrowserBookmarkNode & { children?: BrowserBookmarkNode[] }
  >;
  const rootNode = fullTree[0];
  if (!rootNode?.children) {
    return { tree, mappedBrowserIds };
  }

  function visitChildren(children: BrowserBookmarkNode[], engineParent: string | null): void {
    let mappedIndex = 0;
    for (const child of children) {
      const classified = kindOf(child);
      if (classified === "separator") continue;
      const globalId = state.browserToId[child.id];
      if (globalId) {
        const entityKind: "folder" | "bookmark" = classified === "folder" ? "folder" : "bookmark";
        tree.set(globalId, {
          id: globalId,
          kind: entityKind,
          parentId: engineParent,
          title: child.title,
          url: entityKind === "bookmark" ? (child.url ?? null) : null,
          position: mappedIndex,
          deleted: false,
        });
        mappedBrowserIds.add(child.id);
        mappedIndex += 1;
      }
      if (child.children) {
        visitChildren(child.children, globalId ?? engineParent);
      }
    }
  }

  const rootByBrowserId = new Map<string, BrowserBookmarkNode>();
  for (const child of rootNode.children) {
    rootByBrowserId.set(child.id, child);
  }

  for (const [canonicalRoot, browserRootId] of Object.entries(state.rootMapping)) {
    const browserRoot = browserRootId ? rootByBrowserId.get(browserRootId) : undefined;
    if (!browserRoot?.children) continue;
    visitChildren(browserRoot.children, canonicalRoot);
  }

  return { tree, mappedBrowserIds };
}
