/**
 * blacktea factory.
 *
 * Wires the policy evaluator, rail adapters, history store, idempotency
 * cache, audit sink, and approval callback into a single pay() function
 * that the agent calls for each payment.
 *
 * pay() runs the whole flow in one call (preflight -> policy -> approval ->
 * settle). For callers who cannot resolve a human approval in-process
 * (MCP servers, chat agents where the human is only reachable through the
 * agent), pay also exposes a two-phase API:
 *
 *   pay.stage(input)              -> StageResult
 *       Runs preflight + policy. Auto-approved payments settle and return
 *       { outcome: "completed" }. Rejected ones return { outcome: "rejected" }.
 *       Payments that need approval are HELD and returned as
 *       { outcome: "approval_required", staged } WITHOUT settling.
 *
 *   pay.complete(staged, "approve" | "reject")  -> PaymentIntent
 *       Settles (or denies) a held payment once the human has decided.
 *
 * Flow (request-response, x402-shaped):
 *   1. Validate the input shape (PayInput).
 *   2. Check the idempotency cache. Hit returns cached receipt and data.
 *   3. Pick a rail.
 *   4. rail.preflight(input)  -> PaymentRequirement (amount, recipient, ...).
 *   5. Enforce max_amount if the customer set one.
 *   6. Evaluate the policy with the full PaymentIntentInput.
 *   7. Branch on decision: allow / approval / reject.
 *   8. If approved, rail.settle(input, requirement)  -> { receipt, data }.
 *   9. Record to history, cache the receipt, emit audit, return.
 *
 * v1 simplifications:
 *   - In-process approval channels: console (CLI) and callback
 *     (onApprovalNeeded). Out-of-process approval uses stage/complete.
 *   - PaymentIntent is always in a terminal state when pay() resolves.
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
import type { Decision } from "./policy/decision.js";
import { evaluatePolicy } from "./policy/evaluator.js";
import { loadPolicy } from "./policy/load.js";
import type { Policy } from "./policy/schema.js";
import type {
  AuditEvent,
  AuditSink,
  HistoryStore,
  IdempotencyStore,
  OnApprovalNeeded,
  PayInput,
  PayOptions,
  PaymentIntent,
  PaymentIntentInput,
  PaymentIntentStatus,
  PaymentRequirement,
  RailAdapter,
  Receipt,
  StageResult,
  StagedIntent,
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

export type PayFunction = ((input: PayInput, opts?: PayOptions) => Promise<PaymentIntent>) & {
  /**
   * Two-phase entry point. Runs preflight + policy and either settles
   * (auto-approved / rejected) or holds the payment for an out-of-process
   * human decision. See StageResult.
   */
  stage: (input: PayInput, opts?: PayOptions) => Promise<StageResult>;
  /**
   * Settle (or deny) a payment that stage() held for approval. Pass the
   * StagedIntent it returned and the human's decision.
   */
  complete: (staged: StagedIntent, decision: "approve" | "reject") => Promise<PaymentIntent>;
};

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

  // ---------- shared pipeline: prepare ----------

  // The result of running everything up to and including policy evaluation:
  // a cached hit, a rejection, or a "ready" payment (allow or approval) that
  // still needs settling.
  type PrepareResult =
    | { kind: "cached"; intent: PaymentIntent }
    | { kind: "rejected"; reason: string; ruleFired: string }
    | {
        kind: "ready";
        intentId: string;
        idempotencyKey: string;
        rail: RailAdapter;
        requirement: PaymentRequirement;
        policyInput: PaymentIntentInput;
        decision: Decision;
      };

  async function prepare(input: PayInput, opts: PayOptions): Promise<PrepareResult> {
    validateInput(input);

    const intentId = `intent_${randomUUID()}`;
    const idempotencyKey = opts.idempotency_key ?? intentId;

    emit(audit, "intent_created", intentId, {
      url: input.url,
      intent: input.intent,
      max_amount: input.max_amount,
    });

    // Idempotency first. If we have already settled this exact key, return
    // the prior receipt without re-running policy or hitting the rail.
    const cached = await idempotency.get(idempotencyKey);
    if (cached) {
      emit(audit, "idempotency_hit", intentId, {
        idempotency_key: idempotencyKey,
        original_receipt_id: cached.id,
      });
      return {
        kind: "cached",
        intent: makeTerminalIntent(intentId, input, "completed", cached, undefined),
      };
    }

    const rail = pickRail(rails, input, opts.rail);
    emit(audit, "rail_chosen", intentId, { rail: rail.name });

    let requirement: PaymentRequirement;
    try {
      requirement = await rail.preflight(input);
    } catch (err) {
      emit(audit, "preflight_failed", intentId, {
        rail: rail.name,
        error: (err as Error).message,
      });
      throw new RailUnavailableError(rail.name, (err as Error).message);
    }
    emit(audit, "preflight_received", intentId, {
      amount: requirement.amount,
      currency: requirement.currency,
      recipient_wallet: requirement.recipient_wallet,
    });

    // Pre-policy hard cap: if the server asks for more than the customer was
    // willing to pay, no policy evaluation can rescue it.
    if (input.max_amount !== undefined && requirement.amount > input.max_amount) {
      emit(audit, "payment_denied", intentId, {
        reason: "max_amount_exceeded",
        rule_fired: "input.max_amount",
        requested: requirement.amount,
        cap: input.max_amount,
      });
      return { kind: "rejected", reason: "max_amount_exceeded", ruleFired: "input.max_amount" };
    }

    const policyInput: PaymentIntentInput = {
      amount: requirement.amount,
      currency: requirement.currency,
      url: input.url,
      intent: input.intent,
      ...(requirement.recipient_wallet ? { recipient_wallet: requirement.recipient_wallet } : {}),
    };

    const decision = await evaluatePolicy(policyInput, policy, history);
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
      return { kind: "rejected", reason: decision.reason, ruleFired: decision.rule_fired };
    }

    return { kind: "ready", intentId, idempotencyKey, rail, requirement, policyInput, decision };
  }

  // ---------- shared pipeline: settle + record ----------

  async function settleAndRecord(args: {
    intentId: string;
    idempotencyKey: string;
    rail: RailAdapter;
    requirement: PaymentRequirement;
    policyInput: PaymentIntentInput;
    ruleFired: string;
    input: PayInput;
    opts: PayOptions;
  }): Promise<PaymentIntent> {
    const { intentId, idempotencyKey, rail, requirement, policyInput, ruleFired, input, opts } =
      args;

    let receipt: Receipt;
    let data: unknown;
    if (dryRun) {
      receipt = makeSimulatedReceipt(intentId, policyInput, rail);
      data = undefined;
      emit(audit, "payment_simulated", intentId, {
        rail: rail.name,
        amount: requirement.amount,
      });
    } else {
      emit(audit, "rail_called", intentId, { rail: rail.name });
      try {
        const settled = await rail.settle(input, requirement, opts);
        receipt = settled.receipt;
        data = settled.data;
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
      rule_fired: ruleFired,
      intent_id: intentId,
    });

    await idempotency.put(idempotencyKey, receipt, DEFAULT_IDEMPOTENCY_TTL_SECONDS);

    emit(audit, "payment_completed", intentId, {
      rail: receipt.rail,
      charge_id: receipt.rail_charge_id,
      amount: receipt.amount,
      simulated: receipt.simulated ?? false,
    });

    return makeTerminalIntent(intentId, input, "completed", receipt, data);
  }

  // ---------- one-shot pay ----------

  async function pay(input: PayInput, opts: PayOptions = {}): Promise<PaymentIntent> {
    const prep = await prepare(input, opts);
    if (prep.kind === "cached") return prep.intent;
    if (prep.kind === "rejected") throw new PolicyDeniedError(prep.reason, prep.ruleFired);

    const { intentId, idempotencyKey, rail, requirement, policyInput, decision } = prep;

    if (decision.kind === "approval") {
      const ok = await runApprovalFlow({
        intentId,
        policyInput,
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

    return settleAndRecord({
      intentId,
      idempotencyKey,
      rail,
      requirement,
      policyInput,
      ruleFired: decision.rule_fired,
      input,
      opts,
    });
  }

  // ---------- two-phase: stage ----------

  async function stage(input: PayInput, opts: PayOptions = {}): Promise<StageResult> {
    const prep = await prepare(input, opts);
    if (prep.kind === "cached") return { outcome: "completed", intent: prep.intent };
    if (prep.kind === "rejected") {
      return { outcome: "rejected", reason: prep.reason, rule_fired: prep.ruleFired };
    }

    const { intentId, idempotencyKey, rail, requirement, policyInput, decision } = prep;

    if (decision.kind === "approval") {
      // Honor the policy's timeout_seconds at stage time. complete() refuses
      // to approve a stage past expires_at; the MCP server uses this instead
      // of a fixed TTL for the staged-intents map.
      const expiresAt = new Date(Date.now() + decision.timeout_seconds * 1000).toISOString();
      const staged: StagedIntent = {
        intent_id: intentId,
        amount: requirement.amount,
        currency: requirement.currency,
        ...(requirement.recipient_wallet ? { recipient_wallet: requirement.recipient_wallet } : {}),
        recipient_url: input.url,
        intent: input.intent,
        rule_fired: decision.rule_fired,
        expires_at: expiresAt,
        _input: input,
        _requirement: requirement,
        _opts: opts,
        _railName: rail.name,
        _idempotencyKey: idempotencyKey,
      };
      emit(audit, "approval_staged", intentId, {
        amount: requirement.amount,
        currency: requirement.currency,
        rule_fired: decision.rule_fired,
        expires_at: expiresAt,
        timeout_seconds: decision.timeout_seconds,
      });
      return { outcome: "approval_required", staged };
    }

    const intent = await settleAndRecord({
      intentId,
      idempotencyKey,
      rail,
      requirement,
      policyInput,
      ruleFired: decision.rule_fired,
      input,
      opts,
    });
    return { outcome: "completed", intent };
  }

  // ---------- two-phase: complete ----------

  async function complete(
    staged: StagedIntent,
    decision: "approve" | "reject",
  ): Promise<PaymentIntent> {
    if (decision === "reject") {
      // A late reject is still a reject. The payment was never going to
      // settle anyway, so we accept it without checking expiry.
      emit(audit, "approval_received", staged.intent_id, { decision: "deny" });
      emit(audit, "payment_denied", staged.intent_id, {
        reason: "approval_denied",
        rule_fired: staged.rule_fired,
      });
      return makeDeniedIntent(staged);
    }

    // Approve path. Refuse if the policy's approval window has elapsed: a
    // stage past expires_at must not become a payment, otherwise the
    // policy's timeout_seconds is meaningless on the two-phase / MCP path.
    const expiresAtMs = Date.parse(staged.expires_at);
    if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
      emit(audit, "approval_timed_out", staged.intent_id, {
        expires_at: staged.expires_at,
      });
      throw new ApprovalTimeoutError(staged.intent_id);
    }

    emit(audit, "approval_received", staged.intent_id, { decision: "approve" });

    const rail = rails.find((r) => r.name === staged._railName);
    if (!rail) {
      throw new NoEligibleRailError([staged._railName]);
    }

    const policyInput: PaymentIntentInput = {
      amount: staged._requirement.amount,
      currency: staged._requirement.currency,
      url: staged._input.url,
      intent: staged._input.intent,
      ...(staged._requirement.recipient_wallet
        ? { recipient_wallet: staged._requirement.recipient_wallet }
        : {}),
    };

    return settleAndRecord({
      intentId: staged.intent_id,
      idempotencyKey: staged._idempotencyKey,
      rail,
      requirement: staged._requirement,
      policyInput,
      ruleFired: staged.rule_fired,
      input: staged._input,
      opts: staged._opts,
    });
  }

  return Object.assign(pay, { stage, complete });
}

// ---------- input validation ----------

function validateInput(input: PayInput): void {
  if (typeof input.url !== "string" || input.url.length === 0) {
    throw new ValidationError("Invalid url. Must be a non-empty string.");
  }
  if (typeof input.intent !== "string") {
    throw new ValidationError("Invalid intent. Must be a string.");
  }
  if (
    input.max_amount !== undefined &&
    (!Number.isFinite(input.max_amount) || input.max_amount <= 0)
  ) {
    throw new ValidationError(
      `Invalid max_amount: ${input.max_amount}. Must be a positive number when provided.`,
    );
  }
}

// ---------- rail selection ----------

function pickRail(
  rails: RailAdapter[],
  input: PayInput,
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

// ---------- approval (in-process channels) ----------

interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
  timed_out?: boolean;
}

async function runApprovalFlow(args: {
  intentId: string;
  policyInput: PaymentIntentInput;
  decision: { channel: "console" | "callback"; timeout_seconds: number; rule_fired: string };
  onApprovalNeeded: OnApprovalNeeded | undefined;
  audit: AuditSink;
}): Promise<ApprovalOutcome> {
  const { intentId, policyInput, decision, onApprovalNeeded, audit } = args;
  const expiresAt = new Date(Date.now() + decision.timeout_seconds * 1000).toISOString();

  emit(audit, "approval_requested", intentId, {
    channel: decision.channel,
    rule_fired: decision.rule_fired,
    expires_at: expiresAt,
  });

  if (decision.channel === "console") {
    return awaitConsoleApproval({
      intentId,
      amount: policyInput.amount,
      currency: policyInput.currency,
      url: policyInput.url,
      intent: policyInput.intent,
      timeoutMs: decision.timeout_seconds * 1000,
    });
  }

  if (!onApprovalNeeded) {
    throw new ValidationError(
      'Policy requires "callback" approval but blacktea() was not given onApprovalNeeded. For MCP servers and chat agents, use pay.stage()/pay.complete() instead.',
    );
  }

  const request = {
    intent_id: intentId,
    amount: policyInput.amount,
    currency: policyInput.currency,
    recipient_wallet: policyInput.recipient_wallet,
    recipient_url: policyInput.url,
    intent: policyInput.intent,
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
  policyInput: PaymentIntentInput,
  rail: RailAdapter,
): Receipt {
  return {
    id: intentId,
    amount: policyInput.amount,
    currency: policyInput.currency,
    rail: rail.name,
    rail_charge_id: `dryrun_${randomUUID()}`,
    recipient_url: policyInput.url,
    recipient_wallet: policyInput.recipient_wallet,
    paid_at: new Date().toISOString(),
    simulated: true,
  };
}

function makeTerminalIntent(
  intentId: string,
  input: PayInput,
  status: PaymentIntentStatus,
  receipt: Receipt,
  data: unknown,
): PaymentIntent {
  const intent: PaymentIntent = {
    id: intentId,
    status,
    input,
    receipt,
    data,
    onStatusChange(cb) {
      queueMicrotask(() => cb(intent));
      return () => {};
    },
  };
  return intent;
}

function makeDeniedIntent(staged: StagedIntent): PaymentIntent {
  const intent: PaymentIntent = {
    id: staged.intent_id,
    status: "denied",
    input: staged._input,
    error: new PolicyDeniedError("approval_denied", staged.rule_fired),
    onStatusChange(cb) {
      queueMicrotask(() => cb(intent));
      return () => {};
    },
  };
  return intent;
}
