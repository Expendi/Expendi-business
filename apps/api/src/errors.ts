import { Data } from "effect";

import { describeDbError } from "./db/error.js";

/** Client-facing failures: their message is safe to return in a response. */
export class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string;
}> {
  readonly status = 400;
}

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message: string;
}> {
  readonly status = 401;
}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly message: string;
}> {
  readonly status = 403;
}

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly message: string;
}> {
  readonly status = 404;
}

export type ClientError = BadRequest | Unauthorized | Forbidden | NotFound;

export function isClientError(error: unknown): error is ClientError {
  return (
    error instanceof BadRequest ||
    error instanceof Unauthorized ||
    error instanceof Forbidden ||
    error instanceof NotFound
  );
}

/** Internal failure. Its message is for logs only and never reaches a client. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export function toDatabaseError(cause: unknown): DatabaseError {
  return new DatabaseError({ message: describeDbError(cause), cause });
}
