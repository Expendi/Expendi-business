import DopplerSDK from "@dopplerhq/node-sdk";

import type { SecretsManager } from "./manager.js";
import { SecretsError } from "./manager.js";

export interface DopplerOptions {
  readonly token: string;
  readonly project?: string | undefined;
  readonly config?: string | undefined;
}

export class DopplerSecretsManager implements SecretsManager {
  constructor(private readonly options: DopplerOptions) {}

  async load(): Promise<unknown> {
    const sdk = new DopplerSDK({ accessToken: this.options.token });
    // SDK 1.3's default transport has no timeout, logs network errors verbatim,
    // and JSON.parse in its response callback can throw outside the promise.
    // Use its public transport hook while retaining SDK auth and endpoint handling.
    sdk.secrets.httpClient.get = async (url, _input, headers) => {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (!response.ok)
          throw new SecretsError(
            `Doppler secret download failed (HTTP ${response.status})`,
          );
        return { data: await response.json(), status: response.status };
      } catch (error) {
        if (error instanceof SecretsError) throw error;
        throw new SecretsError("Doppler secret download failed or timed out");
      }
    };
    // Empty strings are omitted by the SDK; a scoped service token supplies
    // project/config. Explicit selectors support other Doppler token types.
    return sdk.secrets.download(
      this.options.project ?? "",
      this.options.config ?? "",
      { format: "json" },
    );
  }
}
