/**
 * ApprovalRecord: the structured receipt blacktea mints when a payment
 * crosses the approval boundary.
 *
 * The audit log keeps the full event stream. An ApprovalRecord sits on top
 * of it as the queryable decision boundary: one record per intent_id,
 * append-only, written into the same audit JSONL for v1 (signing deferred
 * until the shape is stable).
 *
 * Status: design draft, not yet emitted by agent.ts. Implementation lands
 * in a follow-up PR. See issue #5.
 */

/**
 * Decision route. `revise` is reserved for a future counter-offer flow
 * (returning unsupported in v1 if anyone tries it).
 */
export type ApprovalRoute = "allow" | "reject" | "human_review";

/** Lifecycle state of an in-chat approval. */
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
   * v1 input shape (subject to review):
   *   sha256(method + "\n" + url + "\n" + amount + "\n" + currency + "\n" +
   *          (recipient_wallet ?? "") + "\n" + stableStringify(body))
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
