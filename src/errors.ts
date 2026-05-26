/**
 * Typed error hierarchy.
 *
 * Each error has a stable `code` field so callers can pattern-match in
 * try/catch blocks. The class name is documentation; the code is the
 * contract.
 */

abstract class BlackteaError extends Error {
  abstract readonly code: string;
}

/**
 * Thrown at agent factory time (or first pay() if loaded lazily) when the
 * policy file fails schema validation.
 */
export class PolicyParseError extends BlackteaError {
  readonly code = "policy_parse_error";
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = "PolicyParseError";
  }
}

/**
 * Thrown when the policy outright rejects a payment, OR when an approval
 * comes back as denied. The reason field is the reject code from the
 * policy rule, or an approval-denial reason from the human.
 */
export class PolicyDeniedError extends BlackteaError {
  readonly code = "policy_denied";
  constructor(
    public readonly reason: string,
    public readonly rule_fired?: string,
  ) {
    super(`Payment denied by policy: ${reason}`);
    this.name = "PolicyDeniedError";
  }
}

/**
 * Thrown when no configured rail's supports() returned true for the
 * payment intent. Lists the rails that were considered.
 */
export class NoEligibleRailError extends BlackteaError {
  readonly code = "no_eligible_rail";
  constructor(public readonly considered: string[]) {
    super(`No rail accepts this payment. Considered: ${considered.join(", ")}`);
    this.name = "NoEligibleRailError";
  }
}

/**
 * Thrown when the chosen rail rejected the payment (testnet down, x402
 * facilitator error, signature failure, etc).
 */
export class RailUnavailableError extends BlackteaError {
  readonly code = "rail_unavailable";
  constructor(
    public readonly rail: string,
    public readonly inner_message: string,
  ) {
    super(`Rail "${rail}" failed: ${inner_message}`);
    this.name = "RailUnavailableError";
  }
}

/**
 * Thrown when an approval flow exceeded its timeout. Includes the pending
 * intent id so the caller can resume later if they want.
 */
export class ApprovalTimeoutError extends BlackteaError {
  readonly code = "approval_timeout";
  constructor(public readonly intent_id: string) {
    super(`Approval timed out for intent ${intent_id}`);
    this.name = "ApprovalTimeoutError";
  }
}

/**
 * Thrown when the input shape passed to pay() fails validation.
 */
export class ValidationError extends BlackteaError {
  readonly code = "validation_error";
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Generic transport failure (caught and retried internally before surfacing).
 */
export class NetworkError extends BlackteaError {
  readonly code = "network_error";
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Type guard for blacktea-owned errors. Useful when a caller wants to
 * distinguish library errors from rail-thrown errors or runtime errors.
 */
export function isBlackteaError(err: unknown): err is BlackteaError {
  return (
    err instanceof PolicyParseError ||
    err instanceof PolicyDeniedError ||
    err instanceof NoEligibleRailError ||
    err instanceof RailUnavailableError ||
    err instanceof ApprovalTimeoutError ||
    err instanceof ValidationError ||
    err instanceof NetworkError
  );
}
