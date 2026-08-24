/**
 * Loop prevention.
 *
 * Remote operations are applied through `applyRemotely`, which raises an
 * in-memory guard for the whole awaited call stack. Bookmark events that fire
 * while the guard is up are sync-generated, not user changes, and are
 * ignored by the local-change listeners.
 *
 * Belt-and-braces: browser-local node ids touched by remote application are
 * remembered until the next sync cycle starts, so late-arriving events (e.g.
 * a change event delivered after the create promise resolved) are still
 * recognized. This is identity-based checking, not timing-based suppression:
 * correctness does not depend on any delay value.
 */

let applyingRemote = false;
let appliedBrowserIds = new Set<string>();

export function isApplyingRemotely(): boolean {
  return applyingRemote;
}

export function wasAppliedBySync(browserId: string): boolean {
  return appliedBrowserIds.has(browserId);
}

export async function applyRemotely<T>(fn: () => Promise<T>): Promise<T> {
  const previous = applyingRemote;
  applyingRemote = true;
  try {
    return await fn();
  } finally {
    if (!previous) {
      // Release on the next microtasks so synchronous event dispatch during
      // the final API call is still covered.
      queueMicrotask(() => {
        queueMicrotask(() => {
          applyingRemote = false;
        });
      });
    }
  }
}

export function trackAppliedBrowserIds(ids: string[]): void {
  for (const id of ids) {
    if (id) appliedBrowserIds.add(id);
  }
}

export function resetAppliedTracking(): void {
  appliedBrowserIds = new Set();
}
