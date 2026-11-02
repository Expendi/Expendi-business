import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url(),
  /** The Privy SDK refuses any app ID that isn't 25 characters. */
  NEXT_PUBLIC_PRIVY_APP_ID: z.string().length(25),
  NEXT_PUBLIC_PRIVY_CLIENT_ID: z.string().min(1).optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export type PublicEnvResult =
  { ok: true; env: PublicEnv } | { ok: false; invalidKeys: string[] };

const blankToUndefined = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only for static
 * member access, so every variable is read by name.
 */
export function readPublicEnv(): PublicEnvResult {
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    NEXT_PUBLIC_PRIVY_CLIENT_ID: blankToUndefined(
      process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID,
    ),
  });
  if (result.success) return { ok: true, env: result.data };
  return {
    ok: false,
    invalidKeys: result.error.issues.map((issue) => issue.path.join(".")),
  };
}
