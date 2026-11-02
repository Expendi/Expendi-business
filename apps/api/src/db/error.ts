/**
 * Render a database error into one diagnostic string that includes the
 * underlying cause. Drizzle wraps failed queries in an error whose message is
 * only "Failed query: <sql>"; the pg error (code, detail, constraint) lives
 * on `.cause`. Server-side logging only: never send this to a client.
 */
interface PgLikeError {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly detail?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
}

export function describeDbError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as PgLikeError;

    if (typeof e.message === "string" && e.message.length > 0) {
      const extra = [
        typeof e.code === "string" ? `code=${e.code}` : null,
        typeof e.detail === "string" ? `detail=${e.detail}` : null,
        typeof e.constraint === "string" ? `constraint=${e.constraint}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      parts.push(extra ? `${e.message} (${extra})` : e.message);
    }

    current = e.cause;
  }

  return parts.length > 0 ? parts.join(" <- ") : String(error);
}

/** The unique constraint or index a failed write hit, if that's why it failed. */
export function violatedUniqueConstraint(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as PgLikeError;
    if (e.code === "23505" && typeof e.constraint === "string") {
      return e.constraint;
    }
    current = e.cause;
  }
  return null;
}
