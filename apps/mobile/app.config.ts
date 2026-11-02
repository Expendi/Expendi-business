import type { ConfigContext, ExpoConfig } from "expo/config";

const APP_ID = "app.expendi.business";
const PASSKEY_DOMAIN = "business.expendi.app";
const EAS_PROJECT_ID = "3c092318-4971-433e-b238-6b4586e09bac";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Expendi Business",
  slug: "expendi-business",
  owner: "chizaalabs",
  scheme: "expendi-business",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    fallbackToCacheTimeout: 0,
  },
  newArchEnabled: true,
  ios: {
    bundleIdentifier: APP_ID,
    supportsTablet: false,
    associatedDomains: [`webcredentials:${PASSKEY_DOMAIN}`],
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: APP_ID,
    edgeToEdgeEnabled: true,
  },
  extra: { eas: { projectId: EAS_PROJECT_ID } },
  experiments: {
    tsconfigPaths: true,
    typedRoutes: true,
    reactCompiler: true,
  },
  plugins: [
    "expo-router",
    "expo-updates",
    "expo-secure-store",
    "expo-web-browser",
    ["expo-splash-screen", { backgroundColor: "#FFFFFF" }],
    [
      "expo-image-picker",
      {
        cameraPermission:
          "Expendi Business uses the camera to photograph your receipts.",
        photosPermission:
          "Expendi Business uses your photos to attach receipt images and M-Pesa screenshots.",
        microphonePermission: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Expendi Business uses the camera to photograph your receipts and scan eTIMS QR codes.",
        recordAudioAndroid: false,
      },
    ],
  ],
});
