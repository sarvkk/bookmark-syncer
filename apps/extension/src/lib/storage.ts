import { browser } from "#imports";
import type { SyncOperation } from "@syncer/shared";

export type SyncStatus = "unauthenticated" | "idle" | "syncing" | "error";

export interface SyncState {
  apiUrl: string;
  userId?: string;
  userToken?: string;
  deviceId?: string;
  deviceToken?: string;
  deviceName: string;
  rootMapping: Record<string, string>;
  lastCursor: number;
  pendingOps: SyncOperation[];
  deferredOps: DeferredOperation[];
  idToBrowser: Record<string, string>;
  browserToId: Record<string, string>;
  status: SyncStatus;
  lastSyncAt?: number;
  lastError?: string;
  /** Earliest timestamp at which automatic sync cycles may run again. */
  nextAttemptAt?: number;
}

export interface DeferredOperation {
  operation: SyncOperation;
  attempts: number;
}

export const MAX_DEFERRED_ATTEMPTS = 30;
export const DEFAULT_API_URL = "http://localhost:8787";

const STATE_KEY = "syncState";

export function defaultState(): SyncState {
  return {
    apiUrl: DEFAULT_API_URL,
    deviceName: "Unknown device",
    rootMapping: {},
    lastCursor: 0,
    pendingOps: [],
    deferredOps: [],
    idToBrowser: {},
    browserToId: {},
    status: "unauthenticated",
  };
}

let cache: SyncState | null = null;

export async function loadState(): Promise<SyncState> {
  if (cache) return cache;
  const result = await browser.storage.local.get(STATE_KEY);
  cache = { ...defaultState(), ...(result[STATE_KEY] as Partial<SyncState> | undefined) };
  return cache!;
}

export async function saveState(state: SyncState): Promise<void> {
  cache = state;
  await browser.storage.local.set({ [STATE_KEY]: state });
}

export async function updateState(
  mutate: (state: SyncState) => SyncState | void | Promise<SyncState | void>,
): Promise<SyncState> {
  const state = await loadState();
  const result = await mutate(state);
  const next = (result ?? state) as SyncState;
  await saveState(next);
  return next;
}

export async function resetState(): Promise<void> {
  cache = defaultState();
  await browser.storage.local.set({ [STATE_KEY]: cache });
}

/**
 * Clears identity, queues, cursors and mappings while keeping user
 * preferences (apiUrl). Used when (re)connecting so stale credentials,
 * dead entity mappings or an advanced cursor from a wiped database can
 * never poison a fresh account.
 */
export async function resetSyncProgress(): Promise<SyncState> {
  const state = await loadState();
  const fresh = defaultState();
  fresh.apiUrl = state.apiUrl;
  cache = fresh;
  await browser.storage.local.set({ [STATE_KEY]: fresh });
  return fresh;
}
