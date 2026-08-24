import { browser, defineBackground } from "#imports";
import { registerBookmarkListeners } from "../lib/listeners";
import { connectAccount, runSyncCycle } from "../lib/sync-loop";
import { loadState } from "../lib/storage";
import type { StatusResponse } from "../lib/messages";
import { StatusMessage } from "../lib/messages";

const ALARM_NAME = "periodic-sync";

export default defineBackground(() => {
  registerBookmarkListeners();

  browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void runSyncCycle();
    }
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    void runSyncCycle();
  });

  browser.runtime.onStartup.addListener(() => {
    void runSyncCycle();
  });

  // Kick a cycle whenever the service worker wakes up; the running flag and
  // persisted state make this cheap and safe to repeat.
  void runSyncCycle().catch((error) => console.warn("startup sync failed:", error));

  browser.runtime.onMessage.addListener((message: unknown) => {
    const parsed = StatusMessage.safeParse(message);
    if (!parsed.success) return undefined;

    switch (parsed.data.type) {
      case "GET_STATUS":
        return handleGetStatus();
      case "SYNC_NOW":
        return runSyncCycle({ force: true })
          .then(() => handleGetStatus())
          .catch(() => handleGetStatus());
      case "CONNECT":
        return connectAccount(parsed.data.email)
          .then(async (result) => ({
            ...(await handleGetStatus()),
            connectError: result.ok ? undefined : (result.error ?? "connection failed"),
          }))
          .catch(() => handleGetStatus());
    }
  });

  async function handleGetStatus(): Promise<StatusResponse> {
    const state = await loadState();
    return {
      status: state.status,
      lastError: state.lastError,
      connected: Boolean(state.userId && state.deviceId),
      deviceName: state.deviceName,
      lastSyncAt: state.lastSyncAt,
      pendingCount: state.pendingOps.length + state.deferredOps.length,
    };
  }
});
