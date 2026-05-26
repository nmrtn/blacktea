/**
 * blacktea factory.
 *
 * Wires the policy evaluator, rail adapters, history store, idempotency
 * cache, audit sink, and approval callback into a single pay() function
 * that the agent calls for each payment.
 *
 * v1 simplifications (relaxed in later tasks):
 *   - pay() awaits everything internally (no async state machine). The
 *     returned PaymentIntent is always in a terminal state. T8 will add
 *     transitions and a real onStatusChange contract.
 *   - Approval channels: console (CLI prompt) and callback (onApprovalNeeded).
 *     Webhook delivery is deferred to v1.5.
 *   - Rail selection: with one v1 rail, the chosen rail is whichever
 *     supports() returns true first. Or the caller's opts.rail override.
 */

import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  ApprovalTimeoutError,
  NoEligibleRailError,
  PolicyDeniedError,
  RailUnavailableError,
  ValidationError,
} from "./errors.js";
import { FileBackedHistoryStore } from "./history/file-backed.js";
import { InMemoryIdempotencyStore } from "./idempotency/in-memory.js";
import { evaluatePolicy } from "./policy/evaluator.js";
import { loadPolicy } from "./policy/load.js";
import type { Policy } from "./policy/schema.js";
import type {
  AuditEvent,
  AuditSink,
  HistoryStore,
  IdempotencyStore,
  OnApprovalNeeded,
  PayOptions,
  PaymentIntent,
  PaymentIntentInput,
  PaymentIntentStatus,
  RailAdapter,
  Receipt,
} from "./types.js";

export interface BlackteaOptions {
  source: RailAdapter | RailAdapter[];
  policy: Policy | string;
  onApprovalNeeded?: OnApprovalNeeded;
  audit?: AuditSink;
  history?: HistoryStore;
  store?: IdempotencyStore;
  dry_run?: boolean;
}

export type PayFunction = (input: PaymentIntentInput, opts?: PayOptions) => Promise<PaymentIntent>;

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

export function blacktea(options: BlackteaOptions): PayFunction {
  const rails: RailAdapter[] = Array.isArray(options.source) ? options.source : [options.source];
  if (rails.length === 0) {
    throw new ValidationError("blacktea() requires at least one source rail.");
  }

  const policy = loadPolicy(options.policy);
  const audit: AuditSink = options.audit ?? defaultAuditSink;
  const idempotency = options.store ?? new InMemoryIdempotencyStore();
  const history =
    options.history ??
    new FileBackedHistoryStore({
      path: options.dry_run ? "./.blacktea/history-dryrun.jsonl" : "./.blacktea/history.jsonl",
    });
  const dryRun = options.dry_run ?? false;
  const onApprovalNeeded = options.onApprovalNeeded;

  return async function pay(input, opts = {}): Promise<PaymentIntent> {
    validateInput(input);

    const intentId = `intent_${randomUUID()}`;
    const idempotencyKey = opts.idempotency_key ?? intentId;

    emit(audit, "intent_created", intentId, {
      amount: input.amount,
      currency: input.currency,
      url: input.url,
      intent: input.intent,
    });

    // Idempotency check first. If we have already settled this exact key,
    // return the prior receipt without re-running policy or hitting the rail.
    const cached = await idempotency.get(idempotencyKey);
    if (cached) {
      emit(audit, "idempotency_hit", intentId, {
        idempotency_key: idempotencyKey,
        original_receipt_id: cached.id,
      });
      return makeTerminalIntent(intentId, input, "completed", cached);
    }

    const rail = pickRail(rails, input, opts.rail);
    emit(audit, "rail_chosen", intentId, { rail: rail.name });

    const decision = await evaluatePolicy(input, policy, history);
    emit(audit, "policy_evaluated", intentId, {
      decision: decision.kind,
      rule_fired: decision.rule_fired,
      ...(decision.kind === "reject" ? { reason: decision.reason } : {}),
      ...(decision.kind === "approval"
        ? { channel: decision.channel, timeout_seconds: decision.timeout_seconds }
        : {}),
    });

    if (decision.kind === "reject") {
      emit(audit, "payment_denied", intentId, {
        reason: decision.reason,
        rule_fired: decision.rule_fired,
      });
      throw new PolicyDeniedError(decision.reason, decision.rule_fired);
    }

    if (decision.kind === "approval") {
      const ok = await runApprovalFlow({
        intentId,
        input,
        decision,
        onApprovalNeeded,
        audit,
      });
      if (!ok.approved) {
        if (ok.timed_out) {
          emit(audit, "approval_timed_out", intentId, {});
          throw new ApprovalTimeoutError(intentId);
        }
        emit(audit, "payment_denied", intentId, {
          reason: ok.reason ?? "approval_denied",
          rule_fired: decision.rule_fired,
        });
        throw new PolicyDeniedError(ok.reason ?? "approval_denied", decision.rule_fired);
      }
    }

    // Either decision was allow, or approval came back yes. Move money.
    let receipt: Receipt;
    if (dryRun) {
      receipt = makeSimulatedReceipt(intentId, input, rail);
      emit(audit, "payment_simulated", intentId, { rail: rail.name, amount: input.amount });
    } else {
      emit(audit, "rail_called", intentId, { rail: rail.name });
      try {
        receipt = await rail.pay(input, opts);
      } catch (err) {
        emit(audit, "payment_failed", intentId, {
          rail: rail.name,
          error: (err as Error).message,
        });
        throw new RailUnavailableError(rail.name, (err as Error).message);
      }
    }

    await history.record({
      ts: receipt.paid_at,
      amount: receipt.amount,
      currency: receipt.currency,
      recipient_wallet: receipt.recipient_wallet,
      recipient_url: receipt.recipient_url,
      rule_fired: decision.rule_fired,
      intent_id: intentId,
    });

    await idempotency.put(idempotencyKey, receipt, DEFAULT_IDEMPOTENCY_TTL_SECONDS);

    emit(audit, "payment_completed", intentId, {
      rail: receipt.rail,
      charge_id: receipt.rail_charge_id,
      amount: receipt.amount,
      simulated: receipt.simulated ?? false,
    });

    return makeTerminalIntent(intentId, input, "completed", receipt);
  };
}

// ---------- input validation ----------

function validateInput(input: PaymentIntentInput): void {
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
    throw new ValidationError(`Invalid amount: ${input.amount}. Must be a positive number.`);
  }
  if (typeof input.url !== "string" || input.url.length === 0) {
    throw new ValidationError("Invalid url. Must be a non-empty string.");
  }
  if (typeof input.intent !== "string") {
    throw new ValidationError("Invalid intent. Must be a string.");
  }
}

// ---------- rail selection ----------

function pickRail(
  rails: RailAdapter[],
  input: PaymentIntentInput,
  override: string | undefined,
): RailAdapter {
  if (override) {
    const pinned = rails.find((r) => r.name === override);
    if (!pinned) {
      throw new NoEligibleRailError(rails.map((r) => r.name));
    }
    if (!pinned.supports(input)) {
      throw new NoEligibleRailError([pinned.name]);
    }
    return pinned;
  }
  for (const rail of rails) {
    if (rail.supports(input)) return rail;
  }
  throw new NoEligibleRailError(rails.map((r) => r.name));
}

// ---------- approval ----------

interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
  timed_out?: boolean;
}

async function runApprovalFlow(args: {
  intentId: string;
  input: PaymentIntentInput;
  decision: { channel: "console" | "callback"; timeout_seconds: number; rule_fired: string };
  onApprovalNeeded: OnApprovalNeeded | undefined;
  audit: AuditSink;
}): Promise<ApprovalOutcome> {
  const { intentId, input, decision, onApprovalNeeded, audit } = args;
  const expiresAt = new Date(Date.now() + decision.timeout_seconds * 1000).toISOString();

  emit(audit, "approval_requested", intentId, {
    channel: decision.channel,
    rule_fired: decision.rule_fired,
    expires_at: expiresAt,
  });

  if (decision.channel === "console") {
    return awaitConsoleApproval({
      intentId,
      amount: input.amount,
      currency: input.currency ?? "USDC",
      url: input.url,
      intent: input.intent,
      timeoutMs: decision.timeout_seconds * 1000,
    });
  }

  // callback channel
  if (!onApprovalNeeded) {
    throw new ValidationError(
      `Policy requires "callback" approval but blacktea() was not given onApprovalNeeded.`,
    );
  }

  const request = {
    intent_id: intentId,
    amount: input.amount,
    currency: input.currency ?? "USDC",
    recipient_wallet: input.recipient_wallet,
    recipient_url: input.url,
    intent: input.intent,
    rule_fired: decision.rule_fired,
    expires_at: expiresAt,
  };

  const result = await Promise.race([
    onApprovalNeeded(request).then((d) => ({ kind: "decision" as const, d })),
    delay(decision.timeout_seconds * 1000).then(() => ({ kind: "timeout" as const })),
  ]);

  if (result.kind === "timeout") {
    return { approved: false, timed_out: true };
  }
  if (result.d.decision === "approve") {
    emit(audit, "approval_received", intentId, { decision: "approve" });
    return { approved: true };
  }
  emit(audit, "approval_received", intentId, {
    decision: "deny",
    reason: result.d.reason,
  });
  return { approved: false, reason: result.d.reason };
}

async function awaitConsoleApproval(args: {
  intentId: string;
  amount: number;
  currency: string;
  url: string;
  intent: string;
  timeoutMs: number;
}): Promise<ApprovalOutcome> {
  // eslint-disable-next-line no-console
  console.log(`
[blacktea] Approval required for payment ${args.intentId}
  amount:    ${args.amount} ${args.currency}
  recipient: ${args.url}
  reason:    ${args.intent}
`);

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = rl.question("Approve? [y/N] ");
  const result = await Promise.race([
    ask.then((answer) => ({ kind: "answer" as const, answer })),
    delay(args.timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);
  rl.close();

  if (result.kind === "timeout") {
    return { approved: false, timed_out: true };
  }
  const yes = result.answer.trim().toLowerCase() === "y";
  return yes ? { approved: true } : { approved: false, reason: "console_denied" };
}

// ---------- helpers ----------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(audit: AuditSink, event: string, intent_id: string, data: Record<string, unknown>) {
  audit({ ts: new Date().toISOString(), event, intent_id, data });
}

function defaultAuditSink(event: AuditEvent): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event));
}

function makeSimulatedReceipt(
  intentId: string,
  input: PaymentIntentInput,
  rail: RailAdapter,
): Receipt {
  return {
    id: intentId,
    amount: input.amount,
    currency: input.currency ?? "USDC",
    rail: rail.name,
    rail_charge_id: `dryrun_${randomUUID()}`,
    recipient_url: input.url,
    recipient_wallet: input.recipient_wallet,
    paid_at: new Date().toISOString(),
    simulated: true,
  };
}

function makeTerminalIntent(
  intentId: string,
  input: PaymentIntentInput,
  status: PaymentIntentStatus,
  receipt: Receipt,
): PaymentIntent {
  const intent: PaymentIntent = {
    id: intentId,
    status,
    input,
    receipt,
    onStatusChange(cb) {
      // The intent is already in a terminal state when the Promise resolves
      // in v1. Fire the callback once on next tick so the caller's code
      // path matches the future async flow. Return a no-op unsubscribe.
      queueMicrotask(() => cb(intent));
      return () => {};
    },
  };
  return intent;
}
