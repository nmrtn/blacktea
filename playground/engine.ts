/**
 * The playground's engine: Black Tea's own policy schema and evaluator,
 * bundled for the browser by `npm run site:engine`. Nothing here pays
 * anything; history is the list of payments made in this browser tab.
 */

import { matchesFilter } from "../../src/history/filter.js";
import type { Decision } from "../../src/policy/decision.js";
import { evaluatePolicy } from "../../src/policy/evaluator.js";
import { PolicySchema } from "../../src/policy/schema.js";
import type { HistoryFilter, HistoryRecord, PaymentIntentInput } from "../../src/types.js";

export { hostOf } from "../../src/host.js";

export type Verdict = { ok: true; decision: Decision } | { ok: false; errors: string[] };

export async function evaluate(
  policyText: string,
  payment: PaymentIntentInput,
  paid: HistoryRecord[],
): Promise<Verdict> {
  let json: unknown;
  try {
    json = JSON.parse(policyText);
  } catch (err) {
    return { ok: false, errors: [`The policy is not valid JSON: ${(err as Error).message}`] };
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`),
    };
  }

  const since = (opts: { seconds: number; filter?: HistoryFilter }) => {
    const cutoff = Date.now() - opts.seconds * 1000;
    return paid.filter((e) => Date.parse(e.ts) >= cutoff && matchesFilter(e, opts.filter));
  };
  try {
    const decision = await evaluatePolicy(payment, parsed.data, {
      sumSince: async (opts) => since(opts).reduce((sum, e) => sum + e.amount, 0),
      countSince: async (opts) => since(opts).length,
    });
    return { ok: true, decision };
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
}
