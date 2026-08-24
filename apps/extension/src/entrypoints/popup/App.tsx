import { useCallback, useEffect, useState } from "react";
import { browser } from "#imports";
import type { StatusResponse } from "../../lib/messages";

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [email, setEmail] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string>();

  const refresh = useCallback(async () => {
    const response = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    setStatus(response as StatusResponse);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function onConnect() {
    if (!email.trim()) return;
    setConnecting(true);
    setConnectError(undefined);
    const response = (await browser.runtime.sendMessage({
      type: "CONNECT",
      email: email.trim(),
    })) as StatusResponse | undefined;
    setConnecting(false);
    if (response) {
      setStatus(response);
    } else {
      await refresh();
    }
    if (response && !response.connected) {
      setConnectError(response.connectError ?? response.lastError ?? "connection failed");
    }
  }

  async function onSyncNow() {
    const response = await browser.runtime.sendMessage({ type: "SYNC_NOW" });
    setStatus(response as StatusResponse);
  }

  function statusLine(): { label: string; className: string } {
    if (!status?.connected) return { label: "Not connected", className: "muted" };
    if (status.status === "error") return { label: "Error", className: "error" };
    if (status.lastError && status.status === "idle") return { label: "Offline", className: "warn" };
    if (status.status === "syncing") return { label: "Syncing…", className: "ok" };
    return { label: "Connected", className: "ok" };
  }

  const line = statusLine();

  return (
    <main className="popup">
      <h1>Bookmark Sync</h1>

      {!status?.connected ? (
        <section className="setup">
          <label htmlFor="email">Account email</label>
          <input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onConnect();
            }}
          />
          <button onClick={() => void onConnect()} disabled={connecting || !email.trim()}>
            {connecting ? "Connecting…" : "Connect"}
          </button>
          {connectError ? <p className="error detail">{connectError}</p> : null}
          <p className="hint">Development authentication — no password yet.</p>
        </section>
      ) : (
        <>
          <dl>
            <dt>Status</dt>
            <dd className={line.className}>{line.label}</dd>

            <dt>Device</dt>
            <dd>{status.deviceName}</dd>

            <dt>Last sync</dt>
            <dd>{formatTime(status.lastSyncAt)}</dd>

            <dt>Pending</dt>
            <dd>{status.pendingCount}</dd>
          </dl>

          {status.lastError ? <p className="error detail">{status.lastError}</p> : null}

          <button onClick={() => void onSyncNow()} disabled={status.status === "syncing"}>
            Sync now
          </button>
        </>
      )}
    </main>
  );
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return "never";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(timestamp).toLocaleString();
}
