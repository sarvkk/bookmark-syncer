import { z } from "zod";
import {
  MAX_OPERATIONS_PER_PUSH,
  MAX_PULL_LIMIT,
  DEFAULT_PULL_LIMIT,
  SyncOperationSchema,
  type SyncOperation,
} from "./operations";

export type { SyncOperation };

export const PushRequestSchema = z.object({
  operations: z.array(SyncOperationSchema).min(1).max(MAX_OPERATIONS_PER_PUSH),
});

export type PushRequest = z.infer<typeof PushRequestSchema>;

export const PushResultStatus = z.enum(["applied", "duplicate", "rejected"]);
export type PushResultStatus = z.infer<typeof PushResultStatus>;

export const PushResultSchema = z.object({
  operationId: z.uuid(),
  status: PushResultStatus,
  reason: z.string().optional(),
});

export type PushResult = z.infer<typeof PushResultSchema>;

export interface PushResponse {
  results: PushResult[];
  serverCursor: number;
}

export const PullQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(MAX_PULL_LIMIT).default(DEFAULT_PULL_LIMIT),
});

export type PullQuery = z.infer<typeof PullQuerySchema>;

export interface PullResponse {
  operations: SyncOperation[];
  cursor: number;
  hasMore: boolean;
}

export const DeviceRegistrationSchema = z.object({
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(64),
});

export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>;

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export const DevRegisterSchema = z.object({
  email: z.email().max(320),
});

export type DevRegisterRequest = z.infer<typeof DevRegisterSchema>;

export interface DevRegisterResponse {
  userId: string;
  userToken: string;
}

export interface BookmarkTreeNodeDto {
  id: string;
  kind: "bookmark" | "folder" | "root";
  title: string;
  url: string | null;
  position: number;
  children: BookmarkTreeNodeDto[];
}

export interface BookmarkTreeResponse {
  roots: BookmarkTreeNodeDto[];
}

export const AUTH_HEADERS = {
  userId: "x-user-id",
  deviceId: "x-device-id",
} as const;

export function authHeaders(userId?: string, deviceId?: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (userId) headers[AUTH_HEADERS.userId] = userId;
  if (deviceId) headers[AUTH_HEADERS.deviceId] = deviceId;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}
