import { useCallback, useEffect, useState } from "react";
import { authHeaders, type DeviceInfo } from "@syncer/shared";

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
const STORAGE_KEY = "bookmark-sync-session";

interface Session {
  userId: string;
  userToken: string;
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.userId || !parsed.userToken) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [email, setEmail] = useState("");
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/health`);
      setApiHealthy(response.ok);
    } catch {
      setApiHealthy(false);
    }
  }, []);

  const loadDevices = useCallback(async (current: Session) => {
    try {
      setError(undefined);
      const response = await fetch(`${API_URL}/devices`, {
        headers: authHeaders(current.userId, undefined, current.userToken),
      });
      if (response.status === 401) {
        logout();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDevices((await response.json()) as DeviceInfo[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    if (session) void loadDevices(session);
  }, [session, loadDevices]);

  async function login() {
    if (!email.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${API_URL}/auth/dev/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Session;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      setSession(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setDevices([]);
    setSession(null);
  }

  async function removeDevice(id: string) {
    if (!session) return;
    await fetch(`${API_URL}/devices/${id}`, {
      method: "DELETE",
      headers: authHeaders(session.userId, undefined, session.userToken),
    });
    await loadDevices(session);
  }

  return (
    <main>
      <header>
        <h1>Bookmark Sync</h1>
        <span className={apiHealthy === true ? "ok" : apiHealthy === false ? "error" : "muted"}>
          API {apiHealthy === null ? "…" : apiHealthy ? "reachable" : "unreachable"}
        </span>
      </header>

      {!session ? (
        <section className="card">
          <h2>Login</h2>
          <p className="muted">Development authentication — an account is created or re-opened by email.</p>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void login();
            }}
          />
          <button onClick={() => void login()} disabled={busy || !email.trim()}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Account</h2>
            <p className="mono">{session.userId}</p>
            <button onClick={logout}>Log out</button>
          </section>

          <section className="card">
            <h2>Devices ({devices.length})</h2>
            {devices.length === 0 ? (
              <p className="muted">No devices connected yet. Install the browser extension and connect.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Platform</th>
                    <th>Last seen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
                    <tr key={device.id}>
                      <td>{device.name}</td>
                      <td>{device.platform}</td>
                      <td>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "never"}</td>
                      <td>
                        <button onClick={() => void removeDevice(device.id)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {error ? <p className="error">Error: {error}</p> : null}
    </main>
  );
}
