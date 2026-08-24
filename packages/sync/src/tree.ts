import { ROOT_IDS, type RootId } from "@syncer/shared";

export type EntityKind = "bookmark" | "folder";

export interface TreeNode {
  id: string;
  kind: EntityKind;
  parentId: string | null;
  title: string;
  url: string | null;
  position: number;
  deleted: boolean;
}

export type Tree = Map<string, TreeNode>;

export function isRootId(id: string): id is RootId {
  return (ROOT_IDS as readonly string[]).includes(id);
}

export function createEmptyTree(): Tree {
  const tree: Tree = new Map();
  for (const rootId of ROOT_IDS) {
    tree.set(rootId, {
      id: rootId,
      kind: "folder",
      parentId: null,
      title: rootId,
      url: null,
      position: 0,
      deleted: false,
    });
  }
  return tree;
}

export function cloneTree(tree: Tree): Tree {
  const copy: Tree = new Map();
  for (const [id, node] of tree) {
    copy.set(id, { ...node });
  }
  return copy;
}

export function getLiveChildren(tree: Tree, parentId: string): TreeNode[] {
  const children: TreeNode[] = [];
  for (const node of tree.values()) {
    if (!node.deleted && node.parentId === parentId) {
      children.push(node);
    }
  }
  children.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return children;
}

export function clampPosition(position: number, siblingCount: number): number {
  return Math.max(0, Math.min(position, siblingCount));
}

export function isDescendant(tree: Tree, ancestorId: string, candidateId: string): boolean {
  let current = tree.get(candidateId);
  let depth = 0;
  while (current && current.parentId !== null && depth < 10_000) {
    if (current.parentId === ancestorId) return true;
    current = tree.get(current.parentId);
    depth += 1;
  }
  return false;
}

export function collectSubtreeIds(tree: Tree, rootId: string): string[] {
  const ids: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = tree.get(id);
    if (!node || node.deleted) continue;
    ids.push(id);
    for (const child of tree.values()) {
      if (child.parentId === id && !child.deleted) {
        stack.push(child.id);
      }
    }
  }
  return ids;
}
