/**
 * Policy loader tests.
 *
 * Focus: wallet_in file-path resolution. The loader reads a blocklist/
 * allowlist file (one wallet per line, # comments and blanks ignored) and
 * splices the result back in as an inline array, so the evaluator never
 * sees a raw path. Paths in a loaded file resolve relative to the policy
 * file's directory; paths in an object-form policy resolve relative to cwd.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyParseError } from "../../src/errors.js";
import { loadPolicy } from "../../src/policy/load.js";
import type { Policy } from "../../src/policy/schema.js";

describe("loadPolicy wallet_in resolution", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blacktea-load-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function firstRuleWalletIn(policy: Policy): unknown {
    const cond = policy.rules[0]?.if as { wallet_in?: unknown };
    return cond.wallet_in;
  }

  it("resolves a file path into an inline array, stripping comments and blanks", () => {
    writeFileSync(
      join(dir, "blocklist.txt"),
      "# sanctioned wallets\n0xabc\n\n0xdef  # inline comment\n",
    );
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        rules: [{ if: { wallet_in: "./blocklist.txt" }, then: { reject: "sanctioned" } }],
        default: { approve: true },
      }),
    );

    const policy = loadPolicy(policyPath);
    expect(firstRuleWalletIn(policy)).toEqual(["0xabc", "0xdef"]);
  });

  it("resolves the path relative to the policy file's directory, not cwd", () => {
    // The blocklist sits next to the policy file in the temp dir. cwd during
    // the test run is the repo root, which has no such file, so a pass here
    // proves resolution is relative to the policy file.
    writeFileSync(join(dir, "blocklist.txt"), "0xroot\n");
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        rules: [{ if: { wallet_in: "./blocklist.txt" }, then: { reject: "x" } }],
        default: { approve: true },
      }),
    );

    const policy = loadPolicy(policyPath);
    expect(firstRuleWalletIn(policy)).toEqual(["0xroot"]);
  });

  it("resolves wallet_in nested inside an `all` combinator", () => {
    writeFileSync(join(dir, "blocklist.txt"), "0xnested\n");
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        rules: [
          {
            if: { all: [{ amount_gte: 1 }, { wallet_in: "./blocklist.txt" }] },
            then: { reject: "x" },
          },
        ],
        default: { approve: true },
      }),
    );

    const policy = loadPolicy(policyPath);
    const cond = policy.rules[0]?.if as { all: Array<{ wallet_in?: unknown }> };
    expect(cond.all[1]?.wallet_in).toEqual(["0xnested"]);
  });

  it("throws a clear PolicyParseError when the wallet_in file is missing", () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        rules: [{ if: { wallet_in: "./does-not-exist.txt" }, then: { reject: "x" } }],
        default: { approve: true },
      }),
    );

    expect(() => loadPolicy(policyPath)).toThrow(PolicyParseError);
    expect(() => loadPolicy(policyPath)).toThrow(/does not exist/);
  });

  it("leaves an inline array untouched", () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        rules: [{ if: { wallet_in: ["0x1", "0x2"] }, then: { reject: "x" } }],
        default: { approve: true },
      }),
    );

    const policy = loadPolicy(policyPath);
    expect(firstRuleWalletIn(policy)).toEqual(["0x1", "0x2"]);
  });
});
