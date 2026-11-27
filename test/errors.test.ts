import { describe, expect, it } from "vitest";
import { ApprovalInvalidError, QuoteChangedError, isBlackteaError } from "../src/errors.js";

describe("errors", () => {
  it("recognizes the new errors", () => {
    const a = new ApprovalInvalidError("intent_1", "params_changed");
    const q = new QuoteChangedError("x402", "payTo changed");
    expect([a.code, q.code]).toEqual(["approval_invalid", "quote_changed"]);
    expect(isBlackteaError(a) && isBlackteaError(q)).toBe(true);
    expect([a.intent_id, a.reason, q.rail, q.detail]).toEqual([
      "intent_1",
      "params_changed",
      "x402",
      "payTo changed",
    ]);
  });
});
