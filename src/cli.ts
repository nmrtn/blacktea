#!/usr/bin/env node
/**
 * blacktea CLI.
 *
 * Wraps the same library code the SDK exposes, with a shell-friendly
 * interface for human debugging AND for agent platforms with shell
 * tools (Claude Code, Cursor, Cline, Aider, OpenClaw, Hermes, Devin).
 *
 * Commands:
 *   pay              run a paid HTTP request end to end
 *   audit show       inspect the recent history
 *   policy validate  schema-check a policy file
 *   policy test      evaluate a policy against a synthetic payment
 *
 * Output is JSON by default for the data commands (so agents can parse
 * it cleanly with their existing tools). The audit-show command
 * pretty-prints unless --json is passed.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { blacktea } from "./agent.js";
import {
  ApprovalTimeoutError,
  NoEligibleRailError,
  PolicyDeniedError,
  PolicyParseError,
  RailUnavailableError,
  ValidationError,
  isBlackteaError,
} from "./errors.js";
import { evaluatePolicy } from "./policy/evaluator.js";
import { loadPolicy } from "./policy/load.js";
import { PolicySchema } from "./policy/schema.js";
import { x402Wallet } from "./rails/x402.js";
import type { HistoryQuery } from "./types.js";

const VERSION = "0.1.1";

const program = new Command();
program
  .name("blacktea")
  .description("Spending controls for AI agents paying online.")
  .version(VERSION);

// ---------- pay ----------

program
  .command("pay")
  .description("Make a paid HTTP request. Prints { receipt, data } as JSON on success.")
  .requiredOption("-u, --url <url>", "the URL of the paid endpoint")
  .requiredOption("-i, --intent <text>", "natural-language reason for the payment")
  .option(
    "-m, --max-amount <amount>",
    "safety cap (positive number)",
    // Strict parser. Two JS footguns to dodge:
    //   1. Number.parseFloat("1usd") returns 1 (reads as much as it can),
    //      which would silently accept garbage suffixes. We use Number()
    //      instead — it requires the WHOLE string to be a valid number.
    //   2. The previous truthy check on the result dropped NaN and 0 silently,
    //      a fail-open of the user's safety cap. Exit non-zero on any
    //      non-positive-finite value.
    (v: string): number => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        printError({
          code: "invalid_input",
          message: `--max-amount must be a positive number, got: ${JSON.stringify(v)}`,
        });
        process.exit(7);
      }
      return n;
    },
  )
  .option("-p, --policy <path>", "path to policy.json", "./policy.json")
  .option("--chain <chain>", "EVM chain", "base-sepolia")
  .option("--key-env <name>", "env var holding the wallet private key", "EVM_PRIVATE_KEY")
  .action(async (opts) => {
    const pk = process.env[opts.keyEnv];
    if (!pk || !pk.startsWith("0x")) {
      printError({
        code: "config_error",
        message: `Missing or invalid ${opts.keyEnv}. Set the env var or pass --key-env.`,
      });
      process.exit(2);
    }
    if (!existsSync(resolve(opts.policy))) {
      printError({
        code: "config_error",
        message: `Policy file not found: ${resolve(opts.policy)}`,
      });
      process.exit(2);
    }

    const pay = blacktea({
      source: x402Wallet({ privateKey: pk, chain: opts.chain }),
      policy: opts.policy,
      audit: () => {},
    });

    try {
      const intent = await pay({
        url: opts.url,
        intent: opts.intent,
        // Explicit-undefined check, NOT truthy. opts.maxAmount === 0 would
        // never reach here (the strict parser above rejects it), but the
        // explicit check is what we want any future reader to see.
        ...(opts.maxAmount !== undefined ? { max_amount: opts.maxAmount } : {}),
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            receipt: intent.receipt,
            data: intent.data,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      if (isBlackteaError(err)) {
        printError({ code: err.code, message: err.message });
        process.exit(exitCodeFor(err));
      }
      printError({
        code: "unknown_error",
        message: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

// ---------- audit ----------

const audit = program.command("audit").description("Inspect the payment audit log.");

audit
  .command("show")
  .description("Print recent audit events from the history file.")
  .option("-n, --last <n>", "number of events to show", (v) => Number.parseInt(v, 10), 20)
  .option("--json", "output one JSON object per line")
  .option("--store <path>", "path to history file", "./.blacktea/history.jsonl")
  .action((opts) => {
    const path = resolve(opts.store);
    if (!existsSync(path)) {
      printError({
        code: "not_found",
        message: `History file not found: ${path}`,
      });
      process.exit(2);
    }
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const tail = lines.slice(-opts.last);
    if (opts.json) {
      for (const line of tail) console.log(line);
      return;
    }
    // Pretty table
    console.log("Time                      Amount        Rule          Recipient");
    console.log(
      "------------------------- ------------- ------------- ----------------------------------",
    );
    for (const line of tail) {
      try {
        const e = JSON.parse(line) as {
          ts?: string;
          amount?: number;
          currency?: string;
          rule_fired?: string;
          recipient_wallet?: string;
          recipient_url?: string;
        };
        const ts = (e.ts ?? "").padEnd(25);
        const amt = `${e.amount ?? "?"} ${e.currency ?? ""}`.padEnd(13);
        const rule = (e.rule_fired ?? "?").padEnd(13);
        const recipient = e.recipient_wallet ?? e.recipient_url ?? "?";
        console.log(`${ts} ${amt} ${rule} ${recipient}`);
      } catch {
        // Skip malformed lines
      }
    }
  });

// ---------- policy ----------

const policy = program.command("policy").description("Inspect, validate, and test policy files.");

policy
  .command("validate <path>")
  .description("Validate a policy file against the schema.")
  .action((path: string) => {
    const abs = resolve(path);
    if (!existsSync(abs)) {
      printError({ code: "not_found", message: `File not found: ${abs}` });
      process.exit(2);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, "utf-8"));
    } catch (err) {
      printError({
        code: "policy_parse_error",
        message: `Invalid JSON: ${(err as Error).message}`,
      });
      process.exit(1);
    }
    const result = PolicySchema.safeParse(parsed);
    if (result.success) {
      console.log(`OK ${abs} is a valid policy (${result.data.rules.length} rules)`);
      return;
    }
    printError({
      code: "policy_invalid",
      message: `${abs} failed schema validation`,
      details: result.error.format(),
    });
    process.exit(1);
  });

policy
  .command("test <path>")
  .description("Evaluate a policy against a synthetic payment. Prints the Decision.")
  .requiredOption("-a, --amount <n>", "payment amount", Number.parseFloat)
  .requiredOption("-u, --url <url>", "recipient URL")
  .option("-i, --intent <text>", "agent intent string", "test")
  .option("-w, --wallet <address>", "recipient wallet address", "")
  .option("-c, --currency <code>", "currency code", "USDC")
  .action(async (path: string, opts) => {
    let pol: ReturnType<typeof loadPolicy>;
    try {
      pol = loadPolicy(path);
    } catch (err) {
      if (err instanceof PolicyParseError) {
        printError({ code: err.code, message: err.message, details: err.issues });
        process.exit(1);
      }
      throw err;
    }

    // Empty history; "policy test" is for snapshot-style checks, not
    // for testing rolling caps against real spending data.
    const emptyHistory: HistoryQuery = {
      sumSince: async () => 0,
      countSince: async () => 0,
    };

    try {
      const decision = await evaluatePolicy(
        {
          amount: opts.amount,
          currency: opts.currency,
          url: opts.url,
          intent: opts.intent,
          ...(opts.wallet ? { recipient_wallet: opts.wallet } : {}),
        },
        pol,
        emptyHistory,
      );
      console.log(JSON.stringify(decision, null, 2));
    } catch (err) {
      printError({
        code: "evaluation_error",
        message: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

// ---------- helpers ----------

interface PrintErrorArgs {
  code: string;
  message: string;
  details?: unknown;
}

function printError(err: PrintErrorArgs): void {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
      null,
      2,
    ),
  );
}

function exitCodeFor(err: unknown): number {
  if (err instanceof PolicyDeniedError) return 3;
  if (err instanceof ApprovalTimeoutError) return 4;
  if (err instanceof NoEligibleRailError) return 5;
  if (err instanceof RailUnavailableError) return 6;
  if (err instanceof ValidationError) return 7;
  if (err instanceof PolicyParseError) return 8;
  return 1;
}

await program.parseAsync(process.argv);
