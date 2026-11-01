/**
 * Provider-neutral contract. Providers return the raw payload; it is
 * validated in full before anything is applied.
 */
export interface SecretsManager {
  load(): Promise<unknown>;
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

const SECRET_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Never include secret values in errors. */
export function parseSecrets(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SecretsError("Secrets manager returned an invalid secret map");
  const entries: [string, unknown][] = Object.entries(value);
  const secrets: Record<string, string> = {};
  for (const [key, secret] of entries) {
    if (
      !SECRET_KEY.test(key) ||
      FORBIDDEN_KEYS.has(key) ||
      typeof secret !== "string" ||
      secret.includes("\u0000")
    )
      throw new SecretsError(
        "Secrets manager returned an invalid secret entry",
      );
    secrets[key] = secret;
  }
  return secrets;
}

/** Overlays provider secrets onto the environment that Effect Config reads. */
export async function applySecrets(
  manager: SecretsManager,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let secrets: Record<string, string>;
  try {
    secrets = parseSecrets(await manager.load());
  } catch (error) {
    if (error instanceof SecretsError) throw error;
    // Provider errors can contain credentials, request headers or response bodies.
    throw new SecretsError("Secrets manager could not load secrets");
  }
  for (const [key, value] of Object.entries(secrets)) environment[key] = value;
}
