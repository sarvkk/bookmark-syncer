import { z } from "zod";

export const StatusMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("GET_STATUS") }),
  z.object({ type: z.literal("SYNC_NOW") }),
  z.object({ type: z.literal("CONNECT"), email: z.email() }),
]);

export interface StatusResponse {
  connected: boolean;
  status: string;
  deviceName: string;
  lastSyncAt?: number;
  pendingCount: number;
  lastError?: string;
  connectError?: string;
}
