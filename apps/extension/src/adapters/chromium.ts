import { browser } from "#imports";
import type { RootId } from "@syncer/shared";
import { EMPTY_ROOTS, type BrowserAdapter } from "./types";

interface ChromiumChild {
  id: string;
  folderType?: string;
  title?: string;
}

export const chromiumAdapter: BrowserAdapter = {
  id: "chromium",
  async resolveRoots() {
    const roots: Record<RootId, string> = { ...EMPTY_ROOTS };
    const tree = await browser.bookmarks.getTree();
    const rootNode = tree[0];
    if (!rootNode?.children) return roots;

    const children: ChromiumChild[] = rootNode.children;
    for (const child of children) {
      if (child.folderType === "bookmarks-bar") roots.toolbar = child.id;
      else if (child.folderType === "other") roots.other = child.id;
    }
    if (!roots.toolbar) {
      const fallback =
        children.find((c) => /bookmarks bar/i.test(c.title ?? "")) ?? children[0];
      if (fallback) roots.toolbar = fallback.id;
    }
    if (!roots.other) {
      const fallback =
        children.find((c) => /other/i.test(c.title ?? "")) ?? children[1];
      if (fallback) roots.other = fallback.id;
    }
    // Chromium has no menu-bar folder; sync "menu" content into the toolbar.
    roots.menu = roots.toolbar;
    return roots;
  },
};
