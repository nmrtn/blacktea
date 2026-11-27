import { createHash } from "node:crypto";
import { ValidationError } from "../errors.js";
import type { PayInput, PaymentRequirement } from "../types.js";

/**
 * Canonical JSON (RFC 8785, JCS) for JSON values: object keys sorted by
 * UTF-16 code unit, no whitespace, JSON.stringify for strings and numbers.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const members = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`);
  return `{${members.join(",")}}`;
}

/**
 * Binds an approval to the exact request: method, url, amount, currency,
 * recipient and body. Intent and headers are deliberately excluded.
 * Format: "sha256:jcs-v1:" + 64 hex chars.
 */
export function computeParamsHash(input: PayInput, requirement: PaymentRequirement): string {
  let body: unknown;
  try {
    // Round-trip so Date, undefined members and toJSON behave as on the wire.
    body = JSON.parse(JSON.stringify(input.body ?? null));
  } catch {
    throw new ValidationError("Request body is not JSON-serializable.");
  }
  const canonical = canonicalize({
    method: (input.method ?? "GET").toUpperCase(),
    url: input.url,
    amount: requirement.amount,
    currency: requirement.currency,
    recipient_wallet: requirement.recipient_wallet ?? null,
    body,
  });
  return `sha256:jcs-v1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
