import { z } from "zod";

const publicEnvSchema = z.object({
  EXPO_PUBLIC_API_URL: z.url(),
  EXPO_PUBLIC_PRIVY_APP_ID: z.string().min(1),
  EXPO_PUBLIC_PRIVY_CLIENT_ID: z.string().min(1),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export type PublicEnvResult =
  { ok: true; env: PublicEnv } | { ok: false; invalidKeys: string[] };

/**
 * Expo inlines `process.env.EXPO_PUBLIC_*` at build time only for static
 * member access, so every variable is read by name.
 */
export function readPublicEnv(): PublicEnvResult {
  const result = publicEnvSchema.safeParse({
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_PRIVY_APP_ID: process.env.EXPO_PUBLIC_PRIVY_APP_ID,
    EXPO_PUBLIC_PRIVY_CLIENT_ID: process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID,
  });
  if (result.success) return { ok: true, env: result.data };
  return {
    ok: false,
    invalidKeys: result.error.issues.map((issue) => issue.path.join(".")),
  };
}
