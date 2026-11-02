import { readFile } from "node:fs/promises";

// Run after EAS has loaded the selected environment, before native compilation.
// Preview/dev builds intentionally continue to use their own environment.
if (
  process.env.EAS_BUILD_PROFILE === "production" ||
  process.argv.includes("--production")
) {
  const errors = [];
  const api = process.env.EXPO_PUBLIC_API_URL;
  try {
    const url = new URL(api ?? "");
    if (url.protocol !== "https:" || url.username || url.password)
      errors.push(
        "EXPO_PUBLIC_API_URL must be an HTTPS URL without credentials.",
      );
  } catch {
    errors.push("Set EXPO_PUBLIC_API_URL in the EAS production environment.");
  }
  if (!/^[a-z0-9]{25}$/.test(process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? ""))
    errors.push("Set the Privy app ID in EXPO_PUBLIC_PRIVY_APP_ID.");
  if (!process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID?.startsWith("client-"))
    errors.push("Set the native Privy client in EXPO_PUBLIC_PRIVY_CLIENT_ID.");
  if (process.env.EAS_BUILD_PLATFORM === "android") {
    try {
      const google = JSON.parse(
        await readFile(process.env.GOOGLE_SERVICES_JSON ?? "", "utf8"),
      );
      if (
        !google.client?.some(
          (client) =>
            client.client_info?.android_client_info?.package_name ===
            "app.expendi.business",
        )
      )
        errors.push(
          "GOOGLE_SERVICES_JSON must contain the app.expendi.business Android client.",
        );
    } catch {
      errors.push(
        "Set GOOGLE_SERVICES_JSON as an EAS production file variable for Android push.",
      );
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(`[release] ${error}`);
    process.exitCode = 1;
  } else
    console.log(
      "[release] Public production configuration is valid. Verify provider/device delivery using the launch runbook.",
    );
}
