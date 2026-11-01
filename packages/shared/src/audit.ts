import { z } from "zod";

export const AUDIT_ACTOR_TYPES = ["user", "staff", "system"] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
