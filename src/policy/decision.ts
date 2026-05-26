/**
 * The Decision type is the result of evaluating a policy against a payment.
 * It mirrors the three actions a rule can emit (approve, approval, reject)
 * but in a normalized shape the rest of the library consumes.
 */

import type { ApprovalChannel, PolicyAction } from "./schema.js";

export type Decision =
  | { kind: "allow" }
  | { kind: "approval"; channel: ApprovalChannel; timeout_seconds: number }
  | { kind: "reject"; reason: string };

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 600;

/**
 * Normalize a PolicyAction (the shape from a parsed policy file) into a
 * Decision (the shape the rest of the library consumes). Resolves the
 * shorthand vs structured approval forms, applies the default timeout.
 */
export function actionToDecision(action: PolicyAction): Decision {
  if ("approve" in action) {
    return { kind: "allow" };
  }
  if ("reject" in action) {
    return { kind: "reject", reason: action.reject };
  }
  // "approval" in action — either a channel string or a structured object.
  const approval = action.approval;
  if (typeof approval === "string") {
    return {
      kind: "approval",
      channel: approval,
      timeout_seconds: DEFAULT_APPROVAL_TIMEOUT_SECONDS,
    };
  }
  return {
    kind: "approval",
    channel: approval.via,
    timeout_seconds: approval.timeout_seconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS,
  };
}
