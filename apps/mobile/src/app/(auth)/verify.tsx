import type { JSX } from "react";
import { Redirect, useLocalSearchParams } from "expo-router";

import { VerifyScreen } from "~/features/auth/verify-screen";

export default function VerifyRoute(): JSX.Element {
  const { email } = useLocalSearchParams<{ email?: string }>();
  if (!email) return <Redirect href="/sign-in" />;
  return <VerifyScreen email={email} />;
}
