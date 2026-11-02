export {
  ApprovalPasskeyGate,
  SetUpApprovalPasskey,
} from "./approval-passkey-gate";
export type { PasskeyAssertion, PasskeyRegistration } from "./passkey-ceremony";
export {
  createApprovalPasskey,
  PasskeyUnavailableError,
  signApprovalChallenge,
} from "./passkey-ceremony";
export type {
  ApprovalOutcome,
  EnrolmentOutcome,
  PasskeyApprovalSteps,
} from "./use-approval-passkey";
export {
  describeApprovalError,
  isRecentLoginRequired,
  useApprovalPasskeyStatus,
  useEnrolApprovalPasskey,
  usePasskeyApproval,
} from "./use-approval-passkey";
