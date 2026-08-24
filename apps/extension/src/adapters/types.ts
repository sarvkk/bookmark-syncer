import type { RootId } from "@syncer/shared";

/**
 * Browser adapters isolate Chromium/Firefox differences.
 *
 * The only meaningful structural difference for synchronization is how
 * canonical root slots ("toolbar", "menu", "other") resolve to concrete
 * browser bookmark nodes:
 *
 * - Chromium (Brave/Helium): exposes "Bookmarks bar" and "Other bookmarks"
 *   (+ managed/mobile). No menu-bar folder by default; "menu" falls back to
 *   the bookmarks bar.
 * - Firefox/Zen: exposes toolbar / menu / unfiled / mobile under a single
 *   root with stable id suffixes regardless of locale.
 */
export interface BrowserAdapter {
  readonly id: "chromium" | "firefox";
  /** Resolve canonical root slots to browser-local root folder ids. */
  resolveRoots(): Promise<Record<RootId, string>>;
}

export const EMPTY_ROOTS: Record<RootId, string> = {
  toolbar: "",
  menu: "",
  other: "",
};
