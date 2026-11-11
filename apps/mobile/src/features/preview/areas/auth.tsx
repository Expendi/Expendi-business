/** DEV PREVIEW — signing in: email, code and the passkey offer. */
import type { JSX } from "react";

import type { PreviewArea } from "../types";
import { SetUpPasskeyScreen } from "~/features/auth/set-up-passkey-screen";
import { SignInScreen } from "~/features/auth/sign-in-screen";
import { VerifyScreen } from "~/features/auth/verify-screen";

function Verify(): JSX.Element {
  return <VerifyScreen email="wanjiru@mawingulabs.co.ke" />;
}

export const AUTH_AREA: PreviewArea = {
  routes: [],
  screens: [
    { key: "sign-in", name: "Sign in", role: "employee", render: SignInScreen },
    { key: "verify", name: "Sign in · code", role: "employee", render: Verify },
    {
      key: "set-up-passkey",
      name: "Sign in · passkey offer",
      role: "employee",
      render: SetUpPasskeyScreen,
    },
  ],
};
