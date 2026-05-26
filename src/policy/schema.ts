/**
 * Policy schema (Zod source of truth).
 *
 * Operators and combinators map one-to-one with the 10 cookbook cases in
 * docs/policy-cookbook.md. Adding or removing an operator here means
 * updating the cookbook, the JSON Schema artifact in schemas/, and the
 * test fixtures.
 *
 * Each Condition variant is a single-key strict object. Two operators
 * on the same condition (e.g. amount_lt AND amount_gte together) are
 * intentionally rejected; the customer expresses ranges via the `all`
 * combinator. This keeps evaluation predictable and avoids ambiguity
 * about what an unlabeled multi-key condition means.
 */

import { z } from "zod";

// HH:MM format, used by time_of_day_between.
const TimeOfDay = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM");

// File path string OR inline array of strings.
// Used by wallet_in and intent operators that need a list source.
const StringList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

// "would_spend" — stateful, structured.
const WouldSpend = z
  .object({
    window_hours: z.number().positive(),
    gte: z.number().nonnegative(),
    by: z.enum(["wallet", "url", "all"]).optional(),
  })
  .strict();

// Recursive Condition type. Each variant is a single-key strict object.
export type PolicyCondition =
  | { amount_lt: number }
  | { amount_lte: number }
  | { amount_gt: number }
  | { amount_gte: number }
  | { wallet_in: string | string[] }
  | { url_starts_with: string }
  | { intent_contains_any: string[] }
  | { intent_contains_all: string[] }
  | { intent_eq: string }
  | { time_of_day_between: [string, string] }
  | { would_spend: z.infer<typeof WouldSpend> }
  | { amount_today_gte: number }
  | { all: PolicyCondition[] }
  | { any: PolicyCondition[] }
  | { not: PolicyCondition };

export const ConditionSchema: z.ZodType<PolicyCondition> = z.lazy(() =>
  z.union([
    z.object({ amount_lt: z.number() }).strict(),
    z.object({ amount_lte: z.number() }).strict(),
    z.object({ amount_gt: z.number() }).strict(),
    z.object({ amount_gte: z.number() }).strict(),
    z.object({ wallet_in: StringList }).strict(),
    z.object({ url_starts_with: z.string().min(1) }).strict(),
    z.object({ intent_contains_any: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({ intent_contains_all: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({ intent_eq: z.string() }).strict(),
    z.object({ time_of_day_between: z.tuple([TimeOfDay, TimeOfDay]) }).strict(),
    z.object({ would_spend: WouldSpend }).strict(),
    z.object({ amount_today_gte: z.number().nonnegative() }).strict(),
    z.object({ all: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
);

// Approval channels in v1. Webhook deferred to v1.5.
export const ApprovalChannelSchema = z.enum(["console", "callback"]);
export type ApprovalChannel = z.infer<typeof ApprovalChannelSchema>;

// Action — either approve, ask, or reject. Discriminated by which key is present.
export const ActionSchema = z.union([
  z.object({ approve: z.literal(true) }).strict(),
  z
    .object({
      approval: z.union([
        ApprovalChannelSchema,
        z
          .object({
            via: ApprovalChannelSchema,
            timeout_seconds: z.number().int().positive().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ reject: z.string().min(1) }).strict(),
]);

export type PolicyAction = z.infer<typeof ActionSchema>;

// A single rule.
export const RuleSchema = z
  .object({
    if: ConditionSchema,
    then: ActionSchema,
  })
  .strict();

export type PolicyRule = z.infer<typeof RuleSchema>;

// Top-level Policy.
export const PolicySchema = z
  .object({
    time_zone: z.string().optional(),
    rules: z.array(RuleSchema),
    default: ActionSchema,
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
