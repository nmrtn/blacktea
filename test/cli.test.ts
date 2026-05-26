/**
 * CLI smoke tests.
 *
 * The underlying logic (schema, evaluator) is exhaustively tested in
 * the unit suites. These tests verify the shell wrapper itself: arg
 * parsing, exit codes, JSON output shape. We run the compiled bin via
 * tsx so tests do not require a pre-built dist.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const CLI_ENTRY = join(REPO_ROOT, "src/cli.ts");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  const result = spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("CLI", () => {
  describe("global flags", () => {
    it("--version prints the version", () => {
      const r = runCli(["--version"]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("--help prints usage text", () => {
      const r = runCli(["--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Usage: blacktea/);
      expect(r.stdout).toMatch(/pay/);
      expect(r.stdout).toMatch(/audit/);
      expect(r.stdout).toMatch(/policy/);
    });
  });

  describe("policy validate", () => {
    it("exits 0 on a valid policy", () => {
      const r = runCli(["policy", "validate", "test/fixtures/cookbook/01-auto-approve.json"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/valid policy/);
    });

    it("exits 1 on an invalid policy", () => {
      const r = runCli(["policy", "validate", "test/fixtures/invalid/missing-default.json"]);
      expect(r.status).toBe(1);
      const parsed = JSON.parse(r.stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("policy_invalid");
    });

    it("exits 2 when the file does not exist", () => {
      const r = runCli(["policy", "validate", "test/fixtures/does-not-exist.json"]);
      expect(r.status).toBe(2);
      const parsed = JSON.parse(r.stderr);
      expect(parsed.error.code).toBe("not_found");
    });
  });

  describe("policy test", () => {
    it("returns an allow Decision when a rule matches", () => {
      const r = runCli([
        "policy",
        "test",
        "test/fixtures/cookbook/01-auto-approve.json",
        "--amount",
        "5",
        "--url",
        "https://api.example.com",
      ]);
      expect(r.status).toBe(0);
      const decision = JSON.parse(r.stdout);
      expect(decision.kind).toBe("allow");
      expect(decision.rule_fired).toBe("rule[0]");
    });

    it("returns the default Decision when no rule matches", () => {
      const r = runCli([
        "policy",
        "test",
        "test/fixtures/cookbook/01-auto-approve.json",
        "--amount",
        "100",
        "--url",
        "https://api.example.com",
      ]);
      expect(r.status).toBe(0);
      const decision = JSON.parse(r.stdout);
      expect(decision.rule_fired).toBe("default");
    });

    it("supports an explicit wallet recipient", () => {
      const r = runCli([
        "policy",
        "test",
        "test/fixtures/cookbook/03-reject-sanctioned.json",
        "--amount",
        "5",
        "--url",
        "https://api.example.com",
        "--wallet",
        "0xabc",
      ]);
      // 03-reject-sanctioned uses a file path for wallet_in which is
      // unresolved; the evaluator throws a clear error. The CLI surfaces
      // it via a non-zero exit.
      expect(r.status).toBe(1);
      const err = JSON.parse(r.stderr);
      expect(err.error.code).toBe("evaluation_error");
    });
  });

  describe("audit show", () => {
    it("exits 2 when the history file does not exist", () => {
      const r = runCli(["audit", "show", "--store", "/tmp/blacktea-nonexistent-history.jsonl"]);
      expect(r.status).toBe(2);
      const err = JSON.parse(r.stderr);
      expect(err.error.code).toBe("not_found");
    });
  });

  describe("pay command surface", () => {
    it("requires the wallet env var", () => {
      const result = spawnSync(
        "npx",
        ["tsx", CLI_ENTRY, "pay", "--url", "https://x.com", "--intent", "test"],
        {
          encoding: "utf-8",
          cwd: REPO_ROOT,
          env: { ...process.env, EVM_PRIVATE_KEY: "" },
        },
      );
      expect(result.status).toBe(2);
      const err = JSON.parse(result.stderr ?? "");
      expect(err.error.code).toBe("config_error");
    });

    it("rejects when policy file is missing", () => {
      const result = spawnSync(
        "npx",
        [
          "tsx",
          CLI_ENTRY,
          "pay",
          "--url",
          "https://x.com",
          "--intent",
          "test",
          "--policy",
          "/tmp/blacktea-nonexistent-policy.json",
        ],
        {
          encoding: "utf-8",
          cwd: REPO_ROOT,
          env: { ...process.env, EVM_PRIVATE_KEY: "0xdeadbeef" },
        },
      );
      expect(result.status).toBe(2);
      const err = JSON.parse(result.stderr ?? "");
      expect(err.error.code).toBe("config_error");
    });
  });
});
