import { z } from "zod";

export const EntityKind = z.enum(["bookmark", "folder"]);
export type EntityKind = z.infer<typeof EntityKind>;

export type OperationType = "CREATE" | "UPDATE" | "MOVE" | "DELETE";
export type { OperationType as SyncOperationType };

export const MAX_TITLE_LENGTH = 512;
export const MAX_URL_LENGTH = 2048;
export const MAX_OPERATIONS_PER_PUSH = 500;
export const DEFAULT_PULL_LIMIT = 200;
export const MAX_PULL_LIMIT = 1000;

export const CreatePayloadSchema = z
  .object({
    kind: EntityKind,
    parentId: z.string().min(1),
    title: z.string().max(MAX_TITLE_LENGTH),
    url: z.url().max(MAX_URL_LENGTH).optional(),
    position: z.number().int().nonnegative(),
  })
  .superRefine((payload, ctx) => {
    if (payload.kind === "bookmark" && !payload.url) {
      ctx.addIssue({
        code: "custom",
        message: "bookmarks require a url",
        path: ["url"],
      });
    }
    if (payload.kind === "folder" && payload.url !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "folders cannot have a url",
        path: ["url"],
      });
    }
  });

export type CreatePayload = z.infer<typeof CreatePayloadSchema>;

export const UpdatePayloadSchema = z
  .object({
    title: z.string().max(MAX_TITLE_LENGTH).optional(),
    url: z.string().max(MAX_URL_LENGTH).optional(),
  })
  .refine((payload) => payload.title !== undefined || payload.url !== undefined, {
    message: "update must change at least one field",
  });

export type UpdatePayload = z.infer<typeof UpdatePayloadSchema>;

export const MovePayloadSchema = z.object({
  parentId: z.string().min(1),
  position: z.number().int().nonnegative(),
});

export type MovePayload = z.infer<typeof MovePayloadSchema>;

export const DeletePayloadSchema = z.object({}).strict();

export type DeletePayload = z.infer<typeof DeletePayloadSchema>;

const BaseOperationSchema = {
  operationId: z.uuid(),
  userId: z.uuid(),
  deviceId: z.uuid(),
  entityId: z.uuid(),
  timestamp: z.number().int().positive(),
};

export const SyncOperationSchema = z.discriminatedUnion("type", [
  z.object({
    ...BaseOperationSchema,
    type: z.literal("CREATE"),
    payload: CreatePayloadSchema,
  }),
  z.object({
    ...BaseOperationSchema,
    type: z.literal("UPDATE"),
    payload: UpdatePayloadSchema,
  }),
  z.object({
    ...BaseOperationSchema,
    type: z.literal("MOVE"),
    payload: MovePayloadSchema,
  }),
  z.object({
    ...BaseOperationSchema,
    type: z.literal("DELETE"),
    payload: DeletePayloadSchema,
  }),
]);

export type SyncOperation = z.infer<typeof SyncOperationSchema>;
