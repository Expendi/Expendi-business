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

/** The request clashes with the current state, e.g. inviting an existing member. */
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string;
}> {
  readonly status = 409;
}

/** The thing the request refers to existed but is used up, e.g. an expired code. */
export class Gone extends Data.TaggedError("Gone")<{
  readonly message: string;
}> {
  readonly status = 410;
}

/** A limit was hit, e.g. asking for SMS codes too often. */
export class TooManyRequests extends Data.TaggedError("TooManyRequests")<{
  readonly message: string;
}> {
  readonly status = 429;
}

/** A feature or provider the request needs is off or unreachable right now. */
export class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly message: string;
}> {
  readonly status = 503;
}

export type ClientError =
  | BadRequest
  | Unauthorized
  | Forbidden
  | NotFound
  | Conflict
  | Gone
  | TooManyRequests
  | ServiceUnavailable;

export function isClientError(error: unknown): error is ClientError {
  return (
    error instanceof BadRequest ||
    error instanceof Unauthorized ||
    error instanceof Forbidden ||
    error instanceof NotFound ||
    error instanceof Conflict ||
    error instanceof Gone ||
    error instanceof TooManyRequests ||
    error instanceof ServiceUnavailable
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
