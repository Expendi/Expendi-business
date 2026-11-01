import "dotenv/config";

import { initializeSecrets } from "./index.js";

// ESM evaluates this once per process; startup blocks until secrets are applied.
await initializeSecrets();
