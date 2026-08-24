import {
  authHeaders,
  type DevRegisterResponse,
  type DeviceCredentials,
  type DeviceInfo,
  type PullResponse,
  type PushResponse,
  type SyncOperation,
} from "@syncer/shared";

export interface ApiAuth {
  apiUrl: string;
  userId?: string;
  userToken?: string;
  deviceId?: string;
  deviceToken?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  url: string,
  init: RequestInit & { auth?: ApiAuth; deviceScoped?: boolean },
): Promise<T> {
  const { auth, deviceScoped, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("content-type", "application/json");
  if (auth) {
    for (const [key, value] of Object.entries(authHeaders(auth.userId, deviceScoped ? auth.deviceId : undefined, deviceScoped ? auth.deviceToken : auth.userToken))) {
      if (value) headers.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { ...rest, headers });
  } catch (error) {
    throw new ApiError(0, `network error: ${String(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(response.status, `HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function requireUserAuth(auth: ApiAuth): asserts auth is ApiAuth & { userId: string; userToken: string } {
  if (!auth.userId || !auth.userToken) throw new ApiError(0, "not authenticated");
}

function requireDeviceAuth(auth: ApiAuth): asserts auth is ApiAuth & { userId: string; deviceId: string; deviceToken: string } {
  if (!auth.userId || !auth.deviceId || !auth.deviceToken) throw new ApiError(0, "device not registered");
}

export async function devRegister(apiUrl: string, email: string): Promise<DevRegisterResponse> {
  return request<DevRegisterResponse>(`${apiUrl}/auth/dev/register`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function registerDevice(auth: ApiAuth, name: string, platform: string): Promise<DeviceCredentials> {
  requireUserAuth(auth);
  return request<DeviceCredentials>(`${auth.apiUrl}/devices`, {
    method: "POST",
    auth,
    body: JSON.stringify({ name, platform }),
  });
}

export async function listDevices(auth: ApiAuth): Promise<DeviceInfo[]> {
  requireUserAuth(auth);
  return request<DeviceInfo[]>(`${auth.apiUrl}/devices`, { method: "GET", auth });
}

export async function pushOperations(auth: ApiAuth, operations: SyncOperation[]): Promise<PushResponse> {
  requireDeviceAuth(auth);
  return request<PushResponse>(`${auth.apiUrl}/sync/push`, {
    method: "POST",
    auth,
    deviceScoped: true,
    body: JSON.stringify({ operations }),
  });
}

export async function pullOperations(auth: ApiAuth, cursor: number, limit: number): Promise<PullResponse> {
  requireDeviceAuth(auth);
  return request<PullResponse>(`${auth.apiUrl}/sync/pull?cursor=${cursor}&limit=${limit}`, {
    method: "GET",
    auth,
    deviceScoped: true,
  });
}
