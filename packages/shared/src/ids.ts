/**
 * Identifier model.
 *
 * - userId:        globally unique, identifies an account.
 * - deviceId:      globally unique per extension installation. Never derived
 *                  from browser bookmark IDs.
 * - entityId:      globally unique bookmark/folder identity. Stable across
 *                  devices and browsers. Browser-local bookmark node IDs are
 *                  meaningless outside a single profile and are only ever
 *                  stored in per-device identity mappings.
 * - operationId:   globally unique per operation. Used for idempotent
 *                  application on both server and clients.
 *
 * Root folders are NOT entities. Each browser exposes different roots, so the
 * protocol defines canonical root slots that adapters map onto real browser
 * roots (see docs/architecture.md).
 */

export const ROOT_IDS = ["toolbar", "menu", "other"] as const;

export type RootId = (typeof ROOT_IDS)[number];

export function isRootId(value: string): value is RootId {
  return (ROOT_IDS as readonly string[]).includes(value);
}

export type EntityId = string;
export type OperationId = string;
export type DeviceId = string;
export type UserId = string;

export function newId(): string {
  return crypto.randomUUID();
}
