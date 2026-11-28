/**
 * The playground's engine: the policy schema and evaluator behind a
 * text-in, verdict-out function, with history held in an array.
 */

import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../site/playground/engine.js";
import type { HistoryRecord } from "../../src/types.js";

const POLICY = JSON.stringify({
  rules: [
    { if: { wallet_in: ["0xBAD"] }, then: { reject: "blocked_wallet" } },
    { if: { would_spend: { window_hours: 24, gte: 20, by: "url" } }, then: { reject: "cap" } },
    { if: { amount_lt: 5 }, then: { approve: true } },
  ],
  default: { approval: "callback" },
});

const payment = (
  over: Partial<{ amount: number; url: string; recipient_wallet: string }> = {},
) => ({
  amount: 4.99,
  currency: "USDC",
  url: "https://api.example.com/v1/page",
  intent: "fetch one page",
  recipient_wallet: "0xabc",
  ...over,
});

const paidTo = (url: string, amount: number): HistoryRecord => ({
  ts: new Date().toISOString(),
  amount,
  currency: "USDC",
  recipient_url: url,
  rule_fired: "rule[2]",
  intent_id: "intent_test",
});

describe("playground engine", () => {
  it("allows, holds and rejects as the policy says", async () => {
    expect(await evaluate(POLICY, payment(), [])).toMatchObject({
      ok: true,
      decision: { kind: "allow", rule_fired: "rule[2]" },
    });
    expect(await evaluate(POLICY, payment({ amount: 12 }), [])).toMatchObject({
      ok: true,
      decision: { kind: "approval", rule_fired: "default" },
    });
    expect(await evaluate(POLICY, payment({ recipient_wallet: "0xbad" }), [])).toMatchObject({
      ok: true,
      decision: { kind: "reject", reason: "blocked_wallet" },
    });
  });

  it("counts earlier payments to the same host, and only those", async () => {
    const paid = [1, 2, 3, 4].map(() => paidTo("https://api.example.com/v1/other", 4.99));
    expect(await evaluate(POLICY, payment(), paid)).toMatchObject({
      decision: { kind: "reject", reason: "cap" },
    });
    const elsewhere = payment({ url: "https://other.example.com/v1/page" });
    expect(await evaluate(POLICY, elsewhere, paid)).toMatchObject({ decision: { kind: "allow" } });
  });

  it("reports a policy that is not JSON or not a valid policy", async () => {
    expect(await evaluate("{ nope", payment(), [])).toMatchObject({ ok: false });
    const unknownOperator =
      '{"rules":[{"if":{"amount_under":5},"then":{"approve":true}}],"default":{"reject":"no"}}';
    const verdict = await evaluate(unknownOperator, payment(), []);
    expect(verdict.ok).toBe(false);
  });
});

// The site is deployed as plain files, so the bundle and the theme are
// committed. These fail when a source changed and its copy was not rebuilt.
describe("committed site files", () => {
  it("engine.js is the current bundle of engine.ts (npm run site:engine)", () => {
    const built = buildSync({
      entryPoints: ["site/playground/engine.ts"],
      bundle: true,
      format: "esm",
      minify: true,
      target: "es2020",
      write: false,
    });
    expect(readFileSync("site/playground/engine.js", "utf-8")).toBe(built.outputFiles[0]?.text);
  });

  it("theme.css and mark.svg match the brand kit (npm run site:theme)", () => {
    expect(readFileSync("site/theme.css", "utf-8")).toBe(readFileSync("brand/theme.css", "utf-8"));
    expect(readFileSync("site/mark.svg", "utf-8")).toBe(
      readFileSync("brand/assets/logo/blacktea-mark.svg", "utf-8"),
    );
  });
});
