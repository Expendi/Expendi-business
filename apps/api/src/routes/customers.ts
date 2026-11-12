import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  customerInputSchema,
  customerUpdateSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  createCustomer,
  listCustomers,
  updateCustomer,
} from "../services/invoices/customers.js";

const uuid = z.uuid();

function customerIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "Customer not found." }));
}

/** Mounted at `/organizations/:organizationId/customers`. Admins write; accountants read. */
export function createCustomerRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        listCustomers(
          c.get("tenant"),
          c.req.query("includeArchived") === "true",
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, customerInputSchema).pipe(
          Effect.flatMap((input) => createCustomer(c.get("tenant"), input)),
        ),
        201,
      ),
    )
    .patch("/:customerId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          customerIdFrom(c.req.param("customerId")),
          readBody(c.req.raw, customerUpdateSchema),
        ]).pipe(
          Effect.flatMap(([customerId, changes]) =>
            updateCustomer(c.get("tenant"), customerId, changes),
          ),
        ),
      ),
    );
}
