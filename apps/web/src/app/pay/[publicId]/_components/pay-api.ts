import { z } from "zod";

import type {
  FundInChain,
  PublicInvoice,
  PublicPayQuote,
} from "@expendi-business/shared";
import {
  publicInvoiceSchema,
  publicPayQuoteSchema,
} from "@expendi-business/shared";

import { NETWORK_ERROR } from "~/components/data/states";

export type PayApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number | null; message: string };

const UNEXPECTED_RESPONSE = "Something went wrong on our side. Try again.";

/**
 * The pay routes are public and live at the API root, so this reads the
 * API URL straight from the build-time variable instead of `readPublicEnv`,
 * which also demands the Privy settings this page never uses.
 */
function apiBase(): string | undefined {
  const url = process.env.NEXT_PUBLIC_API_URL;
  return url ? url.replace(/\/+$/, "") : undefined;
}

/** Every API route answers in `runEffect`'s envelope, these included. */
const errorBodySchema = z.object({
  success: z.literal(false),
  error: z.object({ message: z.string() }),
});

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<PayApiResult<T>> {
  const base = apiBase();
  if (base === undefined) {
    return { ok: false, status: null, message: UNEXPECTED_RESPONSE };
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch {
    return { ok: false, status: null, message: NETWORK_ERROR };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorBodySchema.safeParse(body);
    return {
      ok: false,
      status: response.status,
      message: error.success ? error.data.error.message : UNEXPECTED_RESPONSE,
    };
  }

  const parsed = z
    .object({ success: z.literal(true), data: schema })
    .safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: response.status, message: UNEXPECTED_RESPONSE };
  }
  return { ok: true, data: parsed.data.data };
}

const segment = encodeURIComponent;

export function fetchInvoice(
  publicId: string,
): Promise<PayApiResult<PublicInvoice>> {
  return request(`/pay/${segment(publicId)}`, publicInvoiceSchema);
}

export function createQuote(
  publicId: string,
  chain: FundInChain,
): Promise<PayApiResult<PublicPayQuote>> {
  return request(`/pay/${segment(publicId)}/quotes`, publicPayQuoteSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain }),
  });
}

export function fetchQuote(
  publicId: string,
  quoteId: string,
): Promise<PayApiResult<PublicPayQuote>> {
  return request(
    `/pay/${segment(publicId)}/quotes/${segment(quoteId)}`,
    publicPayQuoteSchema,
  );
}
