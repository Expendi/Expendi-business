import { applySecrets, SecretsError } from "./manager.js";

export type { SecretsManager } from "./manager.js";

/**
 * Deployed environments set `SECRETS_MANAGER=doppler` plus a scoped
 * `DOPPLER_TOKEN`; Doppler values then override anything already in the
 * environment. Local development and tests stay env-only.
 */
export async function initializeSecrets(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const provider = environment.SECRETS_MANAGER?.trim() ?? "";
  if (provider === "" || provider === "env") return;
  if (provider !== "doppler")
    throw new SecretsError(
      "Unsupported SECRETS_MANAGER; expected env or doppler",
    );
  const token = environment.DOPPLER_TOKEN?.trim();
  if (!token)
    throw new SecretsError(
      "DOPPLER_TOKEN is required when SECRETS_MANAGER=doppler",
    );
  const { DopplerSecretsManager } = await import("./doppler.js");
  await applySecrets(
    new DopplerSecretsManager({
      token,
      project: environment.DOPPLER_PROJECT?.trim(),
      config: environment.DOPPLER_CONFIG?.trim(),
    }),
    environment,
  );
}
