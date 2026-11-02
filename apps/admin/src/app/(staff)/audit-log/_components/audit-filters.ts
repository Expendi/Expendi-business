import type {
  AuditActorType,
  AuditSearchQuery,
} from "@expendi-business/shared";
import { AUDIT_ACTOR_TYPES } from "@expendi-business/shared";

/** The search as it lives in the page's URL, so a search can be linked to. */
export type AuditFilters = Omit<AuditSearchQuery, "cursor" | "limit">;

const TEXT_KEYS = [
  "organizationId",
  "actorId",
  "action",
  "actionPrefix",
  "entityType",
  "entityId",
  "from",
  "to",
] as const;

function isActorType(value: string): value is AuditActorType {
  return (AUDIT_ACTOR_TYPES as readonly string[]).includes(value);
}

export function filtersFromParams(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  for (const key of TEXT_KEYS) {
    const value = params.get(key)?.trim();
    if (value) filters[key] = value;
  }
  const actorType = params.get("actorType");
  if (actorType && isActorType(actorType)) filters.actorType = actorType;
  return filters;
}

/** One action box with an exact/prefix switch becomes `action` or `actionPrefix`. */
export function filtersFromForm(form: FormData): AuditFilters {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const action = text("action");
  const prefix = form.get("actionMatch") === "prefix";
  const actorType = text("actorType");
  return {
    organizationId: text("organizationId"),
    actorType: actorType && isActorType(actorType) ? actorType : undefined,
    actorId: text("actorId"),
    action: prefix ? undefined : action,
    actionPrefix: prefix ? action : undefined,
    entityType: text("entityType"),
    entityId: text("entityId"),
    from: text("from"),
    to: text("to"),
  };
}

export function filtersToParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  return params;
}
