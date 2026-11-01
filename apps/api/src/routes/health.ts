import { Hono } from "hono";

import type { HealthResponse } from "@expendi-business/shared";

export function createHealthRoutes(): Hono {
  return new Hono().get("/", (c) =>
    c.json({ status: "ok" } satisfies HealthResponse),
  );
}
