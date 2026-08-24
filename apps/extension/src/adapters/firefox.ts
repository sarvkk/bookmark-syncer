import { browser } from "#imports";
import type { RootId } from "@syncer/shared";
import { EMPTY_ROOTS, type BrowserAdapter } from "./types";

const FIREFOX_ROOT_SUFFIXES: Record<RootId, string> = {
  toolbar: "toolbar_____",
  menu: "menu________",
  other: "unfiled_____",
};

export const firefoxAdapter: BrowserAdapter = {
  id: "firefox",
  async resolveRoots() {
    const roots: Record<RootId, string> = { ...EMPTY_ROOTS };
    const tree = await browser.bookmarks.getTree();
    const rootNode = tree[0];
    if (!rootNode) return roots;

    const allIds = new Set<string>([rootNode.id]);
    if (rootNode.children) {
      for (const child of rootNode.children) allIds.add(child.id);
    }

    for (const rootId of Object.keys(FIREFOX_ROOT_SUFFIXES) as RootId[]) {
      for (const id of allIds) {
        if (id.endsWith(FIREFOX_ROOT_SUFFIXES[rootId])) {
          roots[rootId] = id;
          break;
        }
      }
    }
    return roots;
  },
};
