/**
 * Core types shared across the library.
 *
 * Two payment-related input types matter:
 *   - PayInput: what the customer passes to pay(). Has the URL the agent
 *     wants to call. Amount is not known yet (server decides).
 *   - PaymentIntentInput: what the policy evaluator sees AFTER preflight.
 *     Has the full picture (amount, currency, url, intent, recipient_wallet).
 *
 * The factory builds PaymentIntentInput from PayInput plus the
 * PaymentRequirement that the rail returned from preflight().
 */

/**
 * What the agent passes to pay(). The url is the API endpoint being called.
 * max_amount is an optional safety cap; if the server asks for more, the
 * payment is rejected before the policy even runs.
 */
export interface PayInput {
  url: string;
  intent: string;
  max_amount?: number;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * What a rail's preflight() returns. The price and recipient for the
 * pending payment, as told by the server.
 */
export interface PaymentRequirement {
  amount: number;
  currency: string;
  recipient_wallet?: string;
  network?: string;
  /** Rail-specific extra fields (the raw 402 payload for x402, etc). */
  raw?: unknown;
}

/**
 * What the policy evaluator sees. Built from PayInput + PaymentRequirement.
 * Operators in the policy DSL match on these fields.
 */
export interface PaymentIntentInput {
  amount: number;
  currency: string;
  url: string;
  intent: string;
  recipient_wallet?: string;
}

/**
 * What a rail's settle() returns once payment is signed and the resource
 * is delivered.
 */
export interface SettleResult {
  receipt: Receipt;
  data: unknown;
}

/**
 * What the rail returns after a successful payment.
 */
export interface Receipt {
  id: string;
  amount: number;
  currency: string;
  rail: string;
  rail_charge_id?: string;
  recipient_wallet?: string;
  recipient_url?: string;
  paid_at: string;
  simulated?: boolean;
}

/**
 * The runtime object returned by pay(). Carries the receipt and (for
 * request-response rails like x402) the API response data.
 * v1 PaymentIntents are always in a terminal state when pay() resolves.
 * The async state machine lands in T8.
 */
export interface PaymentIntent {
  id: string;
  status: PaymentIntentStatus;
  input: PayInput;
  receipt?: Receipt;
  data?: unknown;
  error?: Error;
  onStatusChange(cb: (intent: PaymentIntent) => void): () => void;
}

export type PaymentIntentStatus =
  | "pending"
  | "pending_approval"
  | "approved"
  | "completed"
  | "denied"
  | "failed"
  | "timed_out";

/**
 * Options passed to the pay() function for a single payment.
 */
export interface PayOptions {
  idempotency_key?: string;
  rail?: string;
  timeout_seconds?: number;
}

/**
 * A payment rail. v1 ships one (x402Wallet). The interface splits the
 * payment into two steps: preflight to learn the price, then settle to
 * actually pay and retrieve the resource. Push rails (SEPA, ACH) will
 * have a trivial preflight that echoes back the input the agent gave.
 */
export interface RailAdapter {
  name: string;
  supports(input: PayInput): boolean;
  /**
   * Probe the URL (or the destination) to learn what payment is needed.
   * For x402: make the initial HTTP request, read the 402 response,
   * parse the PAYMENT-REQUIRED header, return the requirement.
   * For push rails (future): return the amount the customer specified.
   */
  preflight(input: PayInput): Promise<PaymentRequirement>;
  /**
   * Sign the payment and deliver the resource (or move the money).
   * For x402: retry the request with the PAYMENT-SIGNATURE header,
   * return both the receipt and the response body.
   * For push rails (future): submit the transfer, return the receipt
   * with data left undefined.
   */
  settle(input: PayInput, requirement: PaymentRequirement, opts: PayOptions): Promise<SettleResult>;
}

/**
 * HistoryQuery is the read interface used by the policy evaluator for
 * stateful operators. HistoryStore extends it with write and prune.
 */
export interface HistoryQuery {
  sumSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number>;
  countSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number>;
}

export interface HistoryFilter {
  wallet?: string;
  url?: string;
}

export interface HistoryRecord {
  ts: string;
  amount: number;
  currency: string;
  recipient_wallet?: string;
  recipient_url?: string;
  rule_fired: string;
  intent_id: string;
}

export interface HistoryStore extends HistoryQuery {
  record(event: HistoryRecord): Promise<void>;
  prune(older_than_seconds: number): Promise<number>;
}

/**
 * Idempotency cache. Maps idempotency key to the receipt of the first
 * successful pay() call with that key.
 */
export interface IdempotencyStore {
  get(key: string): Promise<Receipt | null>;
  put(key: string, receipt: Receipt, ttl_seconds: number): Promise<void>;
}

/**
 * Approval channel and callback shapes.
 */
export type ApprovalChannel = "console" | "callback";

export interface ApprovalRequest {
  intent_id: string;
  amount: number;
  currency: string;
  recipient_wallet?: string;
  recipient_url?: string;
  intent: string;
  rule_fired: string;
  expires_at: string;
}

export interface ApprovalDecision {
  decision: "approve" | "deny";
  reason?: string;
}

export type OnApprovalNeeded = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Audit event written by the library at every step of payment processing.
 */
export interface AuditEvent {
  ts: string;
  event: string;
  intent_id: string;
  data: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;
