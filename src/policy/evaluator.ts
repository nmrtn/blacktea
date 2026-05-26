/**
 * Policy evaluator.
 *
 * Walks the policy rules top to bottom, first match wins. Returns the
 * Decision of the first matching rule, or the default if nothing matches.
 *
 * Stateful operators (would_spend, amount_today_gte) call into HistoryQuery
 * to read past payments. Time-based operators (time_of_day_between) call
 * into a `now()` function that defaults to `() => new Date()` and can be
 * injected for tests.
 *
 * wallet_in only accepts arrays here. The "file path" form documented in
 * the cookbook must be resolved by the policy loader before evaluation.
 * Passing a string raises a clear error rather than silently misbehaving.
 */

import type { HistoryQuery, PaymentIntentInput } from "../types.js";
import { type Decision, actionToDecision } from "./decision.js";
import type { Policy, PolicyCondition } from "./schema.js";

export interface EvaluateOptions {
  now?: () => Date;
}

interface EvalContext {
  input: PaymentIntentInput;
  policy: Policy;
  history: HistoryQuery;
  now: () => Date;
}

export async function evaluatePolicy(
  input: PaymentIntentInput,
  policy: Policy,
  history: HistoryQuery,
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const ctx: EvalContext = {
    input,
    policy,
    history,
    now: opts.now ?? (() => new Date()),
  };

  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if (rule && (await matchesCondition(rule.if, ctx))) {
      return actionToDecision(rule.then, `rule[${i}]`);
    }
  }
  return actionToDecision(policy.default, "default");
}

async function matchesCondition(condition: PolicyCondition, ctx: EvalContext): Promise<boolean> {
  // Stateless: amount comparisons
  if ("amount_lt" in condition) return ctx.input.amount < condition.amount_lt;
  if ("amount_lte" in condition) return ctx.input.amount <= condition.amount_lte;
  if ("amount_gt" in condition) return ctx.input.amount > condition.amount_gt;
  if ("amount_gte" in condition) return ctx.input.amount >= condition.amount_gte;

  // Stateless: recipient match
  if ("wallet_in" in condition) {
    return matchWalletIn(condition.wallet_in, ctx.input.recipient_wallet);
  }
  if ("url_starts_with" in condition) {
    return ctx.input.url.startsWith(condition.url_starts_with);
  }

  // Stateless: intent string
  if ("intent_contains_any" in condition) {
    return intentContainsAny(ctx.input.intent, condition.intent_contains_any);
  }
  if ("intent_contains_all" in condition) {
    return intentContainsAll(ctx.input.intent, condition.intent_contains_all);
  }
  if ("intent_eq" in condition) {
    return ctx.input.intent === condition.intent_eq;
  }

  // Stateless: time of day
  if ("time_of_day_between" in condition) {
    return isInTimeWindow(ctx.now(), condition.time_of_day_between, ctx.policy.time_zone ?? "UTC");
  }

  // Stateful: would_spend (structured) and amount_today_gte (shorthand)
  if ("would_spend" in condition) {
    return matchWouldSpend(condition.would_spend, ctx);
  }
  if ("amount_today_gte" in condition) {
    return matchWouldSpend({ window_hours: 24, gte: condition.amount_today_gte }, ctx);
  }

  // Combinators
  if ("all" in condition) {
    for (const sub of condition.all) {
      if (!(await matchesCondition(sub, ctx))) return false;
    }
    return true;
  }
  if ("any" in condition) {
    for (const sub of condition.any) {
      if (await matchesCondition(sub, ctx)) return true;
    }
    return false;
  }
  if ("not" in condition) {
    return !(await matchesCondition(condition.not, ctx));
  }

  // Should not be reachable if the schema is enforced upstream. If we get
  // here, the policy file passed validation but exposes an operator the
  // evaluator does not implement. Loud failure beats silent wrong answer.
  throw new Error(
    `Unhandled policy condition shape: ${JSON.stringify(Object.keys(condition))}. Did you add an operator to the schema without updating the evaluator?`,
  );
}

function matchWalletIn(list: string | string[], walletFromInput: string | undefined): boolean {
  if (typeof list === "string") {
    throw new Error(
      `wallet_in received a file path ("${list}") but the evaluator only accepts inline arrays. Resolve file references in the policy loader before evaluation.`,
    );
  }
  if (!walletFromInput) return false;
  return list.includes(walletFromInput);
}

function intentContainsAny(intent: string, needles: string[]): boolean {
  const haystack = intent.toLowerCase();
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

function intentContainsAll(intent: string, needles: string[]): boolean {
  const haystack = intent.toLowerCase();
  return needles.every((needle) => haystack.includes(needle.toLowerCase()));
}

interface WouldSpendCondition {
  window_hours: number;
  gte: number;
  by?: "wallet" | "url" | "all";
}

async function matchWouldSpend(op: WouldSpendCondition, ctx: EvalContext): Promise<boolean> {
  const seconds = op.window_hours * 3600;
  const filter = filterForScope(op.by, ctx.input);
  const past = await ctx.history.sumSince({ seconds, ...(filter ? { filter } : {}) });
  return past + ctx.input.amount >= op.gte;
}

function filterForScope(
  by: WouldSpendCondition["by"],
  input: PaymentIntentInput,
): { wallet?: string; url?: string } | undefined {
  if (by === "wallet") {
    return input.recipient_wallet ? { wallet: input.recipient_wallet } : undefined;
  }
  if (by === "url") {
    return { url: hostOf(input.url) };
  }
  return undefined; // "all" or omitted
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Returns true if the current local time (in the policy's time_zone) falls
 * within the [start, end] window. The window wraps midnight if start > end.
 */
function isInTimeWindow(now: Date, window: [string, string], timeZone: string): boolean {
  const current = minutesOfDay(now, timeZone);
  const startMins = parseHHMM(window[0]);
  const endMins = parseHHMM(window[1]);

  if (startMins <= endMins) {
    return current >= startMins && current < endMins;
  }
  return current >= startMins || current < endMins;
}

function minutesOfDay(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return hour * 60 + minute;
}

function parseHHMM(s: string): number {
  const parts = s.split(":");
  const h = Number.parseInt(parts[0] ?? "0", 10);
  const m = Number.parseInt(parts[1] ?? "0", 10);
  return h * 60 + m;
}
