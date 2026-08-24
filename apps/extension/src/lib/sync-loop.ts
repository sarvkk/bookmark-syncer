import {
  MAX_OPERATIONS_PER_PUSH,
  type SyncOperation,
} from "@syncer/shared";
import { buildMirrorTree, type MirrorBuildResult } from "./tree-mirror";
import { pullOperations, pushOperations, devRegister, registerDevice, ApiError } from "./api-client";
import { adoptExistingBookmarks, applyRemoteOperation, deferredLimitReached } from "./applier";
import { getBrowserAdapter } from "../adapters";
import { resetAppliedTracking } from "./loop-guard";
import { loadState, resetSyncProgress, saveState, updateState, type SyncState } from "./storage";
import type { Tree } from "@syncer/sync";

const PULL_PAGE_LIMIT = 200;
const PULL_PAGE_SAFETY = 25;

let running = false;

export interface CycleResult {
  ok: boolean;
  error?: string;
  pushed: number;
  pulled: number;
}

export interface CycleOptions {
  /** Pull and apply remote operations without pushing anything. */
  skipPush?: boolean;
  /** Bypass the backoff cooloff (manual "Sync now", connect flow). */
  force?: boolean;
}

const BACKOFF_MS = 90_000;

function isConfigured(state: SyncState): boolean {
  return Boolean(state.userId && state.userToken && state.deviceId && state.deviceToken);
}

async function resolveRootMapping(): Promise<void> {
  await updateState(async (current) => {
    const needsResolve = Object.values(current.rootMapping).every((value) => !value);
    if (!needsResolve) return;
    const adapter = getBrowserAdapter();
    current.rootMapping = await adapter.resolveRoots();
  });
}

/**
 * One full synchronization pass: push local pending operations, then pull and
 * apply remote operations incrementally. Safe to call concurrently; the
 * second caller exits immediately. All remote application goes through the
 * loop guard so browser events caused by this function are not re-enqueued.
 *
 * After server (5xx) or network failures, automatic cycles back off briefly
 * so an unreachable or unmigrated database does not become endless retry
 * spam. Manual syncs bypass the cooloff.
 */
export async function runSyncCycle(options: CycleOptions = {}): Promise<CycleResult> {
  if (running) return { ok: true, pushed: 0, pulled: 0 };

  const preflight = await loadState();
  if (
    !options.force &&
    preflight.nextAttemptAt !== undefined &&
    Date.now() < preflight.nextAttemptAt
  ) {
    return { ok: false, error: "backing off", pushed: 0, pulled: 0 };
  }

  running = true;
  resetAppliedTracking();

  let pushed = 0;
  let pulled = 0;

  try {
    const initialState = await loadState();
    if (!isConfigured(initialState)) {
      return { ok: false, error: "not configured", pushed: 0, pulled: 0 };
    }

    await resolveRootMapping();
    await updateState((current) => {
      current.status = "syncing";
      current.lastError = undefined;
    });

    const auth = {
      apiUrl: initialState.apiUrl,
      userId: initialState.userId!,
      userToken: initialState.userToken!,
      deviceId: initialState.deviceId!,
      deviceToken: initialState.deviceToken!,
    };

    if (!options.skipPush) {
      pushed = await pushPending();
    }

    const pullOutcome = await pullAndApply();

    await updateState((current) => {
      current.status = "idle";
      current.lastSyncAt = Date.now();
      current.nextAttemptAt = undefined;
      if (pullOutcome.error) current.lastError = pullOutcome.error;
    });

    pulled = pullOutcome.pulled;
    return { ok: !pullOutcome.error, error: pullOutcome.error, pushed, pulled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof ApiError && (error.status === 0 || error.status >= 500);
    await updateState((current) => {
      current.status = retryable ? "idle" : "error";
      current.lastError = message;
      if (retryable) current.nextAttemptAt = Date.now() + BACKOFF_MS;
    });
    return { ok: false, error: message, pushed, pulled };
  } finally {
    running = false;
  }
}

/** Pushes pending + deferred operations in FIFO order; drops dead letters. */
async function pushPending(): Promise<number> {
  let totalPushed = 0;

  while (true) {
    const state = await loadState();
    const batch: SyncOperation[] = [];
    for (const deferred of state.deferredOps) {
      if (batch.length >= MAX_OPERATIONS_PER_PUSH) break;
      batch.push(deferred.operation);
    }
    for (const op of state.pendingOps) {
      if (batch.length >= MAX_OPERATIONS_PER_PUSH) break;
      batch.push(op);
    }
    if (batch.length === 0) break;

    const response = await pushOperations(
      {
        apiUrl: state.apiUrl,
        userId: state.userId!,
        userToken: state.userToken!,
        deviceId: state.deviceId!,
        deviceToken: state.deviceToken!,
      },
      batch,
    );
    const acked = new Set<string>();
    const rejected = new Set<string>();

    for (const result of response.results) {
      if (result.status === "rejected") {
        rejected.add(result.operationId);
        console.warn("operation rejected:", result.reason);
      } else {
        acked.add(result.operationId);
        totalPushed += 1;
      }
    }

    state.pendingOps = state.pendingOps.filter((op) => !acked.has(op.operationId) && !rejected.has(op.operationId));
    state.deferredOps = state.deferredOps.filter((deferred) => {
      const id = deferred.operation.operationId;
      return !acked.has(id) && !rejected.has(id);
    });
    await saveState(state);

    if (acked.size === 0) break;
  }

  return totalPushed;
}

interface PullOutcome {
  pulled: number;
  error?: string;
}

async function pullAndApply(): Promise<PullOutcome> {
  let cursorState = await loadState();
  let cursor = cursorState.lastCursor;
  let pulledTotal = 0;

  for (let page = 0; page < PULL_PAGE_SAFETY; page += 1) {
    const response = await pullOperations(
      {
        apiUrl: cursorState.apiUrl,
        userId: cursorState.userId!,
        userToken: cursorState.userToken!,
        deviceId: cursorState.deviceId!,
        deviceToken: cursorState.deviceToken!,
      },
      cursor,
      PULL_PAGE_LIMIT,
    );

    const state = await loadState();
    const mirror = await buildMirrorTree(state);

    for (const op of response.operations) {
      // Operations originating from this device were already applied locally
      // before being pushed; replaying them would only cause churn.
      if (op.deviceId === state.deviceId) continue;

      try {
        const outcome = await applyRemoteOperation(state, mirror.tree, op);
        if (outcome === "deferred") {
          bufferDeferred(state, op);
        }
      } catch (error) {
        console.warn("failed to apply remote operation, buffering for retry:", String(error));
        // The engine tree may be partially mutated; re-buffering is safe
        // because every effect execution is idempotent.
        bufferDeferred(state, op);
      }
    }

    cursor = response.cursor;
    pulledTotal += response.operations.length;

    await updateState((current) => {
      current.lastCursor = Math.max(current.lastCursor, cursor);
    });
    cursorState = await loadState();

    if (!response.hasMore) break;
  }

  await retryDeferredOnce();
  return { pulled: pulledTotal };
}

function bufferDeferred(state: SyncState, op: SyncOperation): void {
  const existing = state.deferredOps.find((d) => d.operation.operationId === op.operationId);
  if (existing) {
    existing.attempts += 1;
  } else {
    state.deferredOps.push({ operation: op, attempts: 1 });
  }
}

/**
 * Second pass after a full pull: dependencies that arrived later in the same
 * cycle are now visible locally.
 */
async function retryDeferredOnce(): Promise<void> {
  const state = await loadState();
  if (state.deferredOps.length === 0) return;

  const mirror: MirrorBuildResult = await buildMirrorTree(state);
  const tree: Tree = mirror.tree;
  const remaining = [...state.deferredOps];
  state.deferredOps = [];

  for (const deferred of remaining) {
    const outcome = await applyRemoteOperation(state, tree, deferred.operation);
    if (outcome === "deferred") {
      deferred.attempts += 1;
      if (!deferredLimitReached(deferred.attempts)) {
        state.deferredOps.push(deferred);
      } else {
        console.warn("dead-lettering deferred operation", deferred.operation.operationId);
      }
    }
  }
  await saveState(state);
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
}

/**
 * Development authentication flow: exchange an email for tokens via the dev
 * endpoint, register this installation as a device, then perform the initial
 * synchronization.
 *
 * Order matters: remote operations are pulled and applied BEFORE existing
 * local bookmarks are adopted, so bookmarks that already exist under the
 * account are matched through identity mappings instead of duplicated.
 */
export async function connectAccount(email: string): Promise<ConnectResult> {
  try {
    const adapter = getBrowserAdapter();
    const platform = adapter.id;
    const deviceName = `${platform}-${(navigator.platform || "device").toLowerCase()}`;

    // Forget any previous account, device identity, cursor and mappings so a
    // reconnect (or a server-side wipe) always starts from clean state.
    await resetSyncProgress();
    const current = await loadState();
    void current;

    const registration = await devRegister(current.apiUrl, email);

    await updateState((c) => {
      c.userId = registration.userId;
      c.userToken = registration.userToken;
    });

    const credentials = await registerDevice(
      { ...current, userId: registration.userId, userToken: registration.userToken },
      deviceName,
      platform,
    );

    await updateState((c) => {
      c.deviceId = credentials.deviceId;
      c.deviceToken = credentials.deviceToken;
      c.deviceName = deviceName;
      c.status = "idle";
    });

    await resolveRootMapping();

    const initialPull = await runSyncCycle({ skipPush: true });
    if (!initialPull.ok) {
      console.warn("initial pull had errors:", initialPull.error);
    }

    await adoptExistingBookmarks(registration.userId, credentials.deviceId);

    const finalCycle = await runSyncCycle({ force: true });
    return finalCycle.ok ? { ok: true } : { ok: false, error: finalCycle.error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
