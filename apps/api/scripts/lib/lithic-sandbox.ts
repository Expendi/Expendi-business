import { Config, Effect, Redacted } from "effect";

import { LITHIC_SANDBOX_URL } from "../../src/services/lithic/lithic-client.js";

export type SandboxBody = Record<string, unknown>;

/** A call to Lithic's sandbox. Exits with Lithic's message when it refuses. */
export async function sandboxCall(
  method: "GET" | "POST",
  path: string,
  body?: SandboxBody,
): Promise<SandboxBody> {
  const apiKey = Redacted.value(
    await Effect.runPromise(Config.redacted("LITHIC_API_KEY")),
  );
  const response = await fetch(`${LITHIC_SANDBOX_URL}${path}`, {
    method,
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      "User-Agent": "expendi-business-scripts",
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = (text ? JSON.parse(text) : {}) as SandboxBody;
  if (!response.ok) {
    const message =
      typeof payload.message === "string" ? payload.message : text;
    throw new Error(`Lithic ${method} ${path}: ${response.status} ${message}`);
  }
  return payload;
}

/** Lithic's sandbox allows about one write a second. */
export function pauseAfterWrite(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_200));
}
