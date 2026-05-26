/**
 * Core types shared across the library.
 *
 * These are the surface customers interact with directly (PaymentIntentInput,
 * Receipt, RailAdapter, etc) plus the interfaces customers can implement to
 * swap library defaults (HistoryQuery, IdempotencyStore).
 */

/**
 * What the agent gives us. The library populates recipient_wallet from
 * the x402 402 response before passing to the policy evaluator.
 */
export interface PaymentIntentInput {
  amount: number;
  currency?: string;
  url: string;
  intent: string;
  recipient_wallet?: string;
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
 * The runtime object representing a payment in flight or completed.
 * In v1 every PaymentIntent the library returns is already in a terminal
 * state (the factory awaits approval and rail execution internally).
 * The async state machine and .onStatusChange transitions land in T8.
 */
export interface PaymentIntent {
  id: string;
  status: PaymentIntentStatus;
  input: PaymentIntentInput;
  receipt?: Receipt;
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
 * A payment rail. v1 ships one implementation (x402Wallet). Future rails
 * (SEPA push, AP2, ACP, cards) implement this same shape.
 */
export interface RailAdapter {
  name: string;
  supports(input: PaymentIntentInput): boolean;
  estimate(input: PaymentIntentInput): { fee: number; eta_seconds: number };
  pay(input: PaymentIntentInput, opts: PayOptions): Promise<Receipt>;
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
 * successful pay() call with that key. v1 default is in-memory LRU+TTL.
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
 * Default sink is JSON lines to stdout.
 */
export interface AuditEvent {
  ts: string;
  event: string;
  intent_id: string;
  data: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;
