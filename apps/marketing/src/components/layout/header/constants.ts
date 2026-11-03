import { prefersReducedMotion } from "~/lib/gsap";

export const SIGN_IN_HREF = "https://app.qonto.com/detectapp.html?appUrl=/";
export const SIGN_UP_HREF = "https://welcome.qonto.com/signup/select-country";

/** Tween length in seconds, collapsed to 0 when the user prefers reduced motion. */
export function motionDuration(seconds: number): number {
  return prefersReducedMotion() ? 0 : seconds;
}
