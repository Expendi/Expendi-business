import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
} from "effect";
import { describe, expect, it } from "vitest";

import type { EmailMessage } from "../../services/email/email-sender.js";
import {
  EmailSender,
  EmailSenderLive,
  makeResendEmailSender,
} from "../../services/email/email-sender.js";
import { inviteEmail } from "../../services/email/invite-email.js";

const API_KEY = "re_test_secret_key";
const FROM = "Expendi Business <team@expendi.test>";

const MESSAGE: EmailMessage = {
  to: "jane@example.com",
  subject: "Hello",
  text: "Hello Jane",
  html: "<p>Hello Jane</p>",
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function sender(respond: () => Promise<Response>) {
  const sent: Sent[] = [];
  const email = makeResendEmailSender(
    { apiKey: Redacted.make(API_KEY), from: FROM },
    (input, init) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return respond();
    },
  );
  return { email, sent };
}

async function failureOf<E>(effect: Effect.Effect<void, E>): Promise<E | null> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;
}

describe("makeResendEmailSender", () => {
  it("sends a message's idempotency key, so Resend drops a retry it already accepted", async () => {
    // #given
    const { email, sent } = sender(() => Promise.resolve(new Response("{}")));

    // #when
    await Effect.runPromise(
      email.send({ ...MESSAGE, idempotencyKey: "notification:event:user" }),
    );

    // #then
    expect(new Headers(sent[0]?.init?.headers).get("Idempotency-Key")).toBe(
      "notification:event:user",
    );
  });

  it("posts the message to Resend's emails endpoint with the API key", async () => {
    // #given
    const { email, sent } = sender(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "em_1" }))),
    );

    // #when
    await Effect.runPromise(email.send(MESSAGE));

    // #then
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    const body = request?.init?.body;
    expect(typeof body === "string" && JSON.parse(body)).toEqual({
      from: FROM,
      to: ["jane@example.com"],
      subject: "Hello",
      text: "Hello Jane",
      html: "<p>Hello Jane</p>",
    });
  });

  it.each([422, 429, 500])(
    "fails with only the status when Resend answers HTTP %i",
    async (status) => {
      // #given
      const { email } = sender(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "jane@example.com bad" }), {
            status,
          }),
        ),
      );

      // #when
      const error = await failureOf(email.send(MESSAGE));

      // #then
      expect(error?.message).toBe(`Resend answered HTTP ${status}`);
    },
  );

  it("fails without details when Resend can't be reached", async () => {
    // #given
    const { email } = sender(() =>
      Promise.reject(new Error("connect ECONNREFUSED jane@example.com")),
    );

    // #when
    const error = await failureOf(email.send(MESSAGE));

    // #then
    expect(error?.message).toBe("Resend unreachable");
  });
});

describe("EmailSenderLive", () => {
  const sendWith = (env: Record<string, string>) =>
    Effect.flatMap(EmailSender, (email) => email.send(MESSAGE)).pipe(
      Effect.provide(
        EmailSenderLive.pipe(
          Layer.provide(
            Layer.setConfigProvider(
              ConfigProvider.fromMap(new Map(Object.entries(env))),
            ),
          ),
        ),
      ),
    );

  it("starts without Resend settings, and every send then fails cleanly", async () => {
    // #when
    const error = await failureOf(sendWith({ RESEND_API_KEY: API_KEY }));

    // #then
    expect(error?.message).toContain("Email isn't configured");
  });
});

describe("inviteEmail", () => {
  it("names the company and inviter, and links the install page", () => {
    // #when
    const message = inviteEmail({
      to: "jane@example.com",
      companyName: "Acme\nLogistics",
      inviterName: "Dennis",
      installUrl: "https://business.expendi.test/install",
    });

    // #then
    expect(message.subject).toBe(
      "Dennis invited you to Acme Logistics on Expendi Business",
    );
    expect(message.text).toContain("https://business.expendi.test/install");
    expect(message.text).toContain("jane@example.com");
  });

  it("escapes names typed by users in the HTML", () => {
    // #when
    const message = inviteEmail({
      to: "jane@example.com",
      companyName: `<script>alert("x")</script> & Co`,
      inviterName: "O'Neil",
      installUrl: "https://business.expendi.test/install?a=1&b=2",
    });

    // #then
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co",
    );
    expect(message.html).toContain("O&#39;Neil");
    expect(message.html).toContain(
      'href="https://business.expendi.test/install?a=1&amp;b=2"',
    );
  });
});
