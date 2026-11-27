/**
 * ApprovalRecord: the structured receipt blacktea mints when a payment
 * crosses the approval boundary AND a human is in the loop.
 *
 * Scope: a record exists only when the policy returned `approval`. Policy
 * rejects and auto-approved payments never produce one; those live in the
 * audit stream.
 *
 * A receipt is a series of full snapshots, one per state change. The latest
 * snapshot for an `intent_id` is the current receipt.
 *
 * Emitted by `agent.ts`, stored in `approvals.jsonl` (see
 * `approvals/file-backed.ts`) and mirrored to the audit sink. Signing is
 * deferred until the shape is stable.
 */

/**
 * Lifecycle state of an approval.
 *
 *   staged    -> waiting for the human
 *   approved  -> human approved, settle in flight
 *   denied    -> human rejected
 *   expired   -> approval window elapsed without a decision
 *   settled   -> post-approval settle succeeded (terminal happy path)
 *   failed    -> post-approval settle failed (rail down, signature, etc)
 */
export type ApprovalState = "staged" | "approved" | "denied" | "expired" | "settled" | "failed";

export interface ApprovalRecord {
  /** Stable id from the staged intent. */
  intent_id: string;
  /** When the receipt was first minted (ISO-8601). */
  created_at: string;
  /** When this snapshot was written (ISO-8601). */
  updated_at: string;
  /** Current lifecycle state. */
  state: ApprovalState;
  /** How the human was reached. */
  channel: "console" | "callback" | "staged";

  /**
   * Provenance. Which MCP server + tool produced the intent. Null when the
   * call did not come through MCP (SDK or CLI usage).
   */
  mcp_server: string | null;
  tool: string | null;

  /** Who initiated the spend. Always null in this version. */
  actor: string | null;

  /** Settlement target. */
  amount: number;
  currency: string;
  recipient_wallet?: string;
  recipient_url: string;

  /** The agent's stated purpose. */
  intent: string;
  /** What the agent says prompted the request. Reported by the agent, not proof. */
  trigger: string | null;
  /** Which policy rule required approval. */
  rule_fired: string;
  /** Why the human denied, when they said. Null on approve, timeout and two-phase. */
  decision_reason: string | null;

  /**
   * Hash of the exact settlement-relevant request. Binds approve to settle:
   * if the request changes between approval and settle, settle must refuse.
   *
   * Format: `sha256:jcs-v1:<hex>` over the RFC 8785 canonical JSON of
   * `{ method, url, amount, currency, recipient_wallet, body }`. Headers are
   * intentionally excluded.
   */
  params_hash: string;

  /** Policy-driven expiry. Honors decision.timeout_seconds, not a fixed TTL. */
  expires_at: string;
}
