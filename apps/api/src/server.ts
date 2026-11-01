import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { ConfigService } from "./config.js";
import { makeRuntime } from "./runtime.js";

const runtime = makeRuntime();
// The first run builds every layer: loads config (incl. Privy), connects to
// the database and runs its role check, all before accepting traffic.
const config = await runtime.runPromise(ConfigService);

const app = createApp({ runtime });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[server] Expendi Business API listening on port ${info.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[server] ${signal} received, shutting down`);
  server.close((closeError) => {
    if (closeError) console.error("[server] close failed", closeError);
    runtime.dispose().then(
      () => process.exit(closeError ? 1 : 0),
      (disposeError: unknown) => {
        console.error("[server] runtime dispose failed", disposeError);
        process.exit(1);
      },
    );
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
