import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

/**
 * Transactional email through Resend's REST API (spec §9): invites now,
 * alerts and the accountant export later. Its message never includes the
 * recipient or Resend's reply, so it can be logged as it is.
 */
export class EmailSendError extends Data.TaggedError("EmailSendError")<{
  readonly message: string;
}> {}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Resend sends a message once per key, for 24 hours. */
  readonly idempotencyKey?: string;
}

export interface EmailSenderShape {
  readonly send: (message: EmailMessage) => Effect.Effect<void, EmailSendError>;
}

export class EmailSender extends Context.Tag("EmailSender")<
  EmailSender,
  EmailSenderShape
>() {}

export interface ResendSettings {
  readonly apiKey: Redacted.Redacted;
  /** A sender on a domain verified in Resend, e.g. `Expendi Business <team@expendi.app>`. */
  readonly from: string;
}

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

export function makeResendEmailSender(
  settings: ResendSettings,
  fetchImpl: typeof fetch = fetch,
): EmailSenderShape {
  return {
    send: (message) =>
      Effect.tryPromise({
        try: () =>
          fetchImpl(RESEND_EMAILS_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Redacted.value(settings.apiKey)}`,
              "Content-Type": "application/json",
              ...(message.idempotencyKey
                ? { "Idempotency-Key": message.idempotencyKey }
                : {}),
            },
            body: JSON.stringify({
              from: settings.from,
              to: [message.to],
              subject: message.subject,
              text: message.text,
              html: message.html,
            }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            redirect: "error",
          }),
        catch: () => new EmailSendError({ message: "Resend unreachable" }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.fail(
                new EmailSendError({
                  message: `Resend answered HTTP ${response.status}`,
                }),
              ),
        ),
      ),
  };
}

const unconfigured: EmailSenderShape = {
  send: () =>
    Effect.fail(
      new EmailSendError({
        message: "Email isn't configured: set RESEND_API_KEY and EMAIL_FROM",
      }),
    ),
};

/**
 * Optional: without both settings the API still starts and every send fails
 * cleanly, which callers already handle (an invite stands without its email).
 */
export const EmailSenderLive: Layer.Layer<
  EmailSender,
  ConfigError.ConfigError
> = Layer.effect(
  EmailSender,
  Effect.gen(function* () {
    const settings = yield* Config.option(
      Config.all({
        apiKey: Config.redacted("RESEND_API_KEY"),
        from: Config.string("EMAIL_FROM"),
      }),
    );
    if (Option.isNone(settings)) {
      console.warn(
        "[email] RESEND_API_KEY and EMAIL_FROM aren't both set; emails won't be sent",
      );
      return unconfigured;
    }
    return makeResendEmailSender(settings.value);
  }),
);
