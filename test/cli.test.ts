/**
 * CLI smoke tests.
 *
 * The underlying logic (schema, evaluator) is exhaustively tested in
 * the unit suites. These tests verify the shell wrapper itself: arg
 * parsing, exit codes, JSON output shape. We run the compiled bin via
 * tsx so tests do not require a pre-built dist.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
      expect(r.stdout.trim()).toBe("0.1.5");
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

    it("resolves a wallet_in file path and rejects a sanctioned recipient", () => {
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
      // 03-reject-sanctioned uses a file path for wallet_in. The loader now
      // resolves blocklists/sanctioned.txt (which contains 0xabc) into an
      // inline array, so the rule fires and the payment is rejected.
      expect(r.status).toBe(0);
      const decision = JSON.parse(r.stdout);
      expect(decision.kind).toBe("reject");
      expect(decision.reason).toBe("sanctioned");
    });

    it("allows a recipient that is not in the wallet_in blocklist file", () => {
      const r = runCli([
        "policy",
        "test",
        "test/fixtures/cookbook/03-reject-sanctioned.json",
        "--amount",
        "5",
        "--url",
        "https://api.example.com",
        "--wallet",
        "0xnotsanctioned",
      ]);
      expect(r.status).toBe(0);
      const decision = JSON.parse(r.stdout);
      expect(decision.kind).toBe("allow");
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

    // Regression: the CLI used to silently drop --max-amount when the value
    // parsed to NaN (e.g. user wrote "1usd" or a shell variable expanded to
    // empty), letting the payment proceed with no cap. The strict parser
    // must exit 7 (validation_error) before any rail or policy work runs.
    // See .gstack/security-reports/ for the audit that found this.
    for (const bad of ["notanumber", "", "0", "-1", "1usd"]) {
      it(`rejects --max-amount ${JSON.stringify(bad)} with exit 7`, () => {
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
            "--max-amount",
            bad,
          ],
          {
            encoding: "utf-8",
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              EVM_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
            },
          },
        );
        expect(result.status).toBe(7);
        const err = JSON.parse(result.stderr ?? "");
        expect(err.error.code).toBe("invalid_input");
        expect(err.error.message).toMatch(/max-amount/);
      });
    }

    it("accepts a positive --max-amount value", () => {
      // Use a non-resolving host so the call fails AFTER input parsing
      // succeeds. We are only checking that the parser does NOT exit 7.
      const result = spawnSync(
        "npx",
        [
          "tsx",
          CLI_ENTRY,
          "pay",
          "--url",
          "http://127.0.0.1:1",
          "--intent",
          "test",
          "--max-amount",
          "1.5",
          "--policy",
          "test/fixtures/cookbook/01-auto-approve.json",
        ],
        {
          encoding: "utf-8",
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            EVM_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
          },
        },
      );
      // Whatever happens after parsing (rail_unavailable, network error,
      // etc.), the exit code must NOT be 7 - the parser accepted the value.
      expect(result.status).not.toBe(7);
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

  describe("approvals show", () => {
    const dir = mkdtempSync(join(tmpdir(), "blacktea-cli-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const base = {
      channel: "callback",
      mcp_server: null,
      tool: null,
      actor: null,
      amount: 5,
      currency: "USDC",
      recipient_wallet: "0xabc",
      recipient_url: "https://x.com/a",
      intent: "buy data",
      rule_fired: "r1",
      decision_reason: null,
      params_hash: "sha256:jcs-v1:00",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const file = join(dir, "approvals.jsonl");
    writeFileSync(
      file,
      `${[
        JSON.stringify({
          ...base,
          intent_id: "a",
          state: "staged",
          trigger: "refund ticket 42",
          updated_at: "2026-01-01T00:00:01.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          ...base,
          intent_id: "a",
          state: "settled",
          trigger: "refund ticket 42",
          updated_at: "2026-01-01T00:00:05.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          ...base,
          intent_id: "b",
          state: "staged",
          trigger: null,
          updated_at: "2026-01-01T00:00:03.000Z",
          expires_at: "2026-01-01T00:10:00.000Z",
        }),
        "not json",
      ].join("\n")}\n`,
    );

    it("pay --help lists --trigger", () => {
      const r = runCli(["pay", "--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("--trigger");
    });

    it("--json prints one line per latest record, with display_state for expired", () => {
      const r = runCli(["approvals", "show", "--store", file, "--json"]);
      expect(r.status).toBe(0);
      const rows = r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2);
      const a = rows.find((x) => x.intent_id === "a");
      const b = rows.find((x) => x.intent_id === "b");
      expect(a.state).toBe("settled");
      expect(b.state).toBe("staged");
      expect(b.display_state).toBe("expired (unresolved)");
    });

    it("table shows state, expired label and trigger", () => {
      const r = runCli(["approvals", "show", "--store", file]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("settled");
      expect(r.stdout).toContain("expired (unresolved)");
      expect(r.stdout).toContain("refund ticket 42");
    });

    it("exits 0 on a missing file", () => {
      const r = runCli(["approvals", "show", "--store", join(dir, "missing.jsonl")]);
      expect(r.status).toBe(0);
    });

    it("-n limits rows", () => {
      const r = runCli(["approvals", "show", "--store", file, "--json", "-n", "1"]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
    });
  });
});
