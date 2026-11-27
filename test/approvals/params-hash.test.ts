import { describe, expect, it } from "vitest";
import { canonicalize, computeParamsHash } from "../../src/approvals/params-hash.js";
import { ValidationError } from "../../src/errors.js";

const input = {
  url: "https://a.test/x",
  intent: "i",
  method: "post",
  body: { q: 1, r: 2 },
};
const req = { amount: 4, currency: "USDC", recipient_wallet: "0xabc" };

describe("canonicalize", () => {
  it("canonicalizes with sorted keys and no whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });
});

describe("computeParamsHash", () => {
  // Known answer. Receipts already on disk carry hashes in this format;
  // changing this value means old receipts no longer verify. Bump the
  // "jcs-v1" tag instead of editing the expected string.
  it("matches the golden vector", () => {
    expect(computeParamsHash(input, req)).toBe(
      "sha256:jcs-v1:45dd1e70241e139efd92e37663646d868ad7eea22e0bcec003715ce14f4d46bc",
    );
  });

  it("has the tagged format", () => {
    expect(computeParamsHash(input, req)).toMatch(/^sha256:jcs-v1:[0-9a-f]{64}$/);
  });

  it("is stable across body key order, method case, intent and headers", () => {
    const other = {
      ...input,
      method: "POST",
      intent: "different",
      headers: { a: "b" },
      body: { r: 2, q: 1 },
    };
    expect(computeParamsHash(other, req)).toBe(computeParamsHash(input, req));
  });

  it.each([
    ["amount", input, { ...req, amount: 5 }],
    ["currency", input, { ...req, currency: "EUR" }],
    ["recipient", input, { ...req, recipient_wallet: "0xdef" }],
    ["url", { ...input, url: "https://a.test/y" }, req],
    ["method", { ...input, method: "GET" }, req],
    ["body", { ...input, body: { q: 1, r: 3 } }, req],
  ])("changes when %s changes", (_n, i, r) => {
    expect(computeParamsHash(i, r)).not.toBe(computeParamsHash(input, req));
  });

  it("treats missing method as GET, missing body and wallet as null", () => {
    const bare = { url: "https://a.test/x", intent: "i" };
    expect(computeParamsHash(bare, { amount: 4, currency: "USDC" })).toBe(
      computeParamsHash({ ...bare, method: "GET", body: null }, { amount: 4, currency: "USDC" }),
    );
  });

  it("rejects a body that is not JSON-serializable", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => computeParamsHash({ ...input, body: cyclic }, req)).toThrow(ValidationError);
    expect(() => computeParamsHash({ ...input, body: { n: 1n } }, req)).toThrow(ValidationError);
  });
});
