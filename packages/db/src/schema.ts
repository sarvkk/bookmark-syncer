import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const entityKind = pgEnum("entity_kind", ["bookmark", "folder"]);

/**
 * users
 *
 * auth_token_hash is the SHA-256 hex digest of the user's bearer token.
 * The plaintext token is shown once at registration and never stored.
 * This is a development-grade scheme; see docs/architecture.md.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    authTokenHash: text("auth_token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    index("devices_user_id_idx").on(table.userId),
    uniqueIndex("devices_token_hash_unique").on(table.tokenHash),
  ],
);

/**
 * bookmarks
 *
 * One row per global entity (bookmark or folder). Tombstones are rows with
 * deleted_at set; they are never resurrected by later operations.
 *
 * Placement uses exactly one of:
 *   - rootId:    canonical root slot ("toolbar" | "menu" | "other")
 *   - parentId:  uuid of the parent folder row
 */
export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: entityKind("kind").notNull(),
    title: text("title").notNull().default(""),
    url: text("url"),
    rootId: text("root_id"),
    parentId: uuid("parent_id"),
    position: bigint("position", { mode: "number" }).notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("bookmarks_user_parent_idx").on(table.userId, table.parentId, table.position),
    index("bookmarks_user_root_idx").on(table.userId, table.rootId, table.position),
  ],
);

/**
 * sync_operations
 *
 * Append-only operation log. `seq` defines the total order every device
 * replays; `operationId` is globally unique and makes pushes idempotent.
 */
export const syncOperations = pgTable(
  "sync_operations",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    operationId: uuid("operation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    clientTimestamp: bigint("client_timestamp", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sync_operations_operation_id_unique").on(table.operationId),
    index("sync_operations_user_seq_idx").on(table.userId, table.seq),
    index("sync_operations_entity_idx").on(table.userId, table.entityId),
  ],
);

export const syncCursors = pgTable("sync_cursors", {
  deviceId: uuid("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * bookmark_locations
 *
 * Tracks which browser-local node id an entity maps to on each device.
 */
export const bookmarkLocations = pgTable(
  "bookmark_locations",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    browserLocalId: text("browser_local_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.deviceId] }),
    index("bookmark_locations_device_idx").on(table.deviceId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  devices: many(devices),
  bookmarks: many(bookmarks),
}));

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one, many }) => ({
  user: one(users, { fields: [bookmarks.userId], references: [users.id] }),
  parent: one(bookmarks, { fields: [bookmarks.parentId], references: [bookmarks.id] }),
  locations: many(bookmarkLocations),
}));

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type BookmarkRow = typeof bookmarks.$inferSelect;
export type SyncOperationRow = typeof syncOperations.$inferSelect;
