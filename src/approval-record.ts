/**
 * ApprovalRecord: the structured receipt blacktea mints when a payment
 * crosses the approval boundary AND a human is in the loop.
 *
 * Scope: a record exists only when the policy returned `approval` and a
 * staged intent was created. Policy rejects (the policy fires `reject`
 * from the start) never produce an ApprovalRecord; those are captured in
 * the audit stream as `payment_denied` events. This keeps the record
 * scoped to "a human made a decision," not "the policy made a decision."
 *
 * Storage: append-only in the same audit JSONL for v1, tagged with
 * `event: "approval_record"`. Signing deferred until the shape is stable.
 *
 * Status: design draft, not yet emitted by agent.ts. Implementation lands
 * in a follow-up PR. See issue #5.
 */

/**
 * Decision route. `revise` is reserved for a future counter-offer flow
 * (returning unsupported in v1 if anyone tries it).
 */
export type ApprovalRoute = "allow" | "reject" | "human_review";

/**
 * Lifecycle state of an in-chat approval. Every state requires a staged
 * intent to have existed; policy rejects without a stage never reach this
 * enum (they live in the audit stream as `payment_denied`).
 *
 *   staged    -> waiting for the human
 *   approved  -> human approved, settle in flight
 *   denied    -> human rejected
 *   expired   -> approval window elapsed without a decision
 *   settled   -> post-approval settle succeeded (terminal happy path)
 *   failed    -> post-approval settle failed (rail down, signature, etc)
 */
export type ApprovalFinalState =
  | "staged"
  | "approved"
  | "denied"
  | "expired"
  | "settled"
  | "failed";

export interface ApprovalRecord {
  /** Stable id from the staged intent. */
  intent_id: string;

  /**
   * Provenance. Which MCP server + tool produced the intent. Null when the
   * call did not come through MCP (SDK or CLI usage).
   */
  mcp_server: string | null;
  tool: string | null;

  /**
   * Who initiated the spend. Null in v1: blacktea assumes one human, one
   * agent, one wallet. Becomes required once shared-wallet / multi-tenant
   * setups land.
   */
  actor: string | null;

  /** Settlement target. */
  amount: number;
  currency: string;
  recipient_wallet?: string;
  recipient_url: string;

  /** Why approval was needed and which policy rule fired. */
  reason: string;
  rule_fired: string;

  /**
   * Hash of the exact settlement-relevant request. Binds approve to settle:
   * if the request changes between approval and settle, the record is
   * invalid and settle must refuse.
   *
   * Format: a tagged string `<alg>:<canonicalization-version>:<hex>`. The
   * tag is atomic with the value so callers can't mix records hashed under
   * different rules. v1 uses `sha256:jcs-v1`:
   *
   *   "sha256:jcs-v1:" + sha256(JCS({
   *     method: method.toUpperCase(),
   *     url,
   *     amount,
   *     currency,
   *     recipient_wallet: recipient_wallet ?? null,
   *     body
   *   }))
   *
   * JCS = RFC 8785 canonical JSON. Headers are intentionally excluded:
   * they drift across clients and proxies, and anything that genuinely
   * changes settlement semantics should be promoted into the explicit
   * request shape before hashing.
   */
  params_hash: string;

  /** Policy-driven expiry. Honors decision.timeout_seconds, not a fixed TTL. */
  expires_at: string;

  /** ISO-8601 timestamp of when the record was minted. */
  created_at: string;

  /** Decision route. */
  route: ApprovalRoute;

  /** Current lifecycle state. */
  final_state: ApprovalFinalState;

  /**
   * Audit event ids that produced this record. The record stays tight,
   * the audit log stays the full trail.
   */
  audit_event_refs: string[];
}
