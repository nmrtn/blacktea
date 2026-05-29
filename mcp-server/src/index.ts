#!/usr/bin/env node
/**
 * blacktea MCP server.
 *
 * Exposes blacktea's payment flow as MCP tools. Drop one config line into
 * Claude Desktop, Cursor, OpenClaw, Hermes, or any MCP-aware client and the
 * assistant gains spending controls with no extra code.
 *
 * Tools exposed:
 *   pay              Attempt a paid HTTP request via x402 with policy enforcement
 *   approve_payment  Approve a payment the policy held for human review
 *   reject_payment   Decline a payment the policy held for human review
 *   audit_query      Read recent payment events from the history file
 *
 * Approval flow: when the policy says a payment needs human approval, `pay`
 * does NOT block or settle. It returns status "approval_required" with an
 * intent_id. The agent relays the amount to the human; if they approve, the
 * agent calls approve_payment with that intent_id (or reject_payment to
 * decline). This is the in-conversation approval pattern - the agent is the
 * channel between the human and the policy.
 *
 * All config via env vars (set by the MCP client when it spawns the server):
 *   EVM_PRIVATE_KEY      required, the wallet's signing key
 *   BLACKTEA_CHAIN       default "base-sepolia"
 *   BLACKTEA_POLICY      path to policy.json, default "./policy.json"
 *   BLACKTEA_HISTORY     path to history.jsonl, default "./.blacktea/history.jsonl"
 *   BLACKTEA_RAIL        "mock" to use the no-network simulated rail (try the
 *                        policy + approval flow with no x402 / wallet / USDC);
 *                        anything else uses the real x402 rail
 *   BLACKTEA_MOCK_AMOUNT price the mock rail "charges", default 0.01
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  FileBackedHistoryStore,
  type StagedIntent,
  blacktea,
  isBlackteaError,
} from "@nmrtn/blacktea";
import { mockWallet, x402Wallet } from "@nmrtn/blacktea/adapters";

const VERSION = "0.1.0";
const PACKAGE_NAME = "@nmrtn/blacktea-mcp";

// How long a staged (awaiting-approval) payment stays valid before it
// auto-expires. The human has this long to approve in the chat.
const STAGED_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------- config from env ----------

// Mock rail mode: no network, no real money, no wallet. Set BLACKTEA_RAIL=mock
// to try the server (policy engine, approval flow, audit) against a simulated
// merchant. BLACKTEA_MOCK_AMOUNT sets the price the mock "charges" (default
// 0.01) so you can exercise auto-approve vs. approval-required vs. reject.
// Read this BEFORE the key check: mock mode must run with no EVM_PRIVATE_KEY.
const useMockRail = process.env.BLACKTEA_RAIL === "mock";
const mockAmount = Number(process.env.BLACKTEA_MOCK_AMOUNT ?? "0.01");

const pk = process.env.EVM_PRIVATE_KEY;
if (!useMockRail && (!pk || !pk.startsWith("0x"))) {
  console.error(`${PACKAGE_NAME}: EVM_PRIVATE_KEY env var is missing or invalid.`);
  console.error("Set it in your MCP client config under the env block,");
  console.error("or set BLACKTEA_RAIL=mock to run without a wallet.");
  process.exit(1);
}

const chain = process.env.BLACKTEA_CHAIN ?? "base-sepolia";
const policyPath = resolve(process.env.BLACKTEA_POLICY ?? "./policy.json");
const historyPath = resolve(process.env.BLACKTEA_HISTORY ?? "./.blacktea/history.jsonl");

if (!existsSync(policyPath)) {
  console.error(`${PACKAGE_NAME}: policy file not found at ${policyPath}.`);
  console.error(
    "Set BLACKTEA_POLICY to a valid path or place policy.json next to the working directory.",
  );
  process.exit(1);
}

// ---------- wire blacktea ----------

// Explicitly construct the history store at historyPath so pay() writes
// and audit_query reads use the SAME file. Without this, the SDK's default
// branch resolves "./.blacktea/history.jsonl" from process.cwd() (whatever
// directory the MCP client spawned us in - often "/" or "$HOME", never
// predictable) while audit_query reads the env-resolved historyPath. The
// two would diverge silently and audit_query would return "no history yet"
// while payments were being recorded somewhere else.
const history = new FileBackedHistoryStore({ path: historyPath });

const pay = blacktea({
  source: useMockRail
    ? mockWallet({ amount: Number.isFinite(mockAmount) ? mockAmount : 0.01 })
    : // pk is guaranteed defined here: the guard above exits unless mock mode.
      x402Wallet({ privateKey: pk as string, chain }),
  policy: policyPath,
  history,
  audit: () => {
    // The MCP transport owns stdout; any audit prints would corrupt the
    // protocol stream. Stay quiet here. The history file is the audit.
  },
});

// Payments the policy held for human approval, keyed by intent_id. Lives in
// memory for the life of this server process (one MCP session). Each entry
// expires after STAGED_TTL_MS so a forgotten approval can't settle hours later.
const stagedIntents = new Map<string, { staged: StagedIntent; expiresAt: number }>();

function pruneExpiredStaged(): void {
  const now = Date.now();
  for (const [id, entry] of stagedIntents) {
    if (now > entry.expiresAt) stagedIntents.delete(id);
  }
}

// ---------- response helpers ----------

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...payload }) }],
  };
}

function err(code: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: { code, message, ...extra } }),
      },
    ],
    isError: true,
  };
}

// Not isError - a held payment is a normal control-flow pause, not a failure.
// The agent should read this, ask the human, and call approve_payment.
function pending(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, ...payload }) }],
  };
}

// ---------- MCP server ----------

const server = new Server(
  { name: PACKAGE_NAME, version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pay",
      description:
        'Pay for a paid HTTP resource via x402. The endpoint may charge USDC on Base. Use when you need data from a paywalled API, a premium data feed, or any x402-enabled URL. blacktea applies the spending policy before signing. IMPORTANT: if the policy requires human approval, this returns status "approval_required" with an intent_id and an amount - do NOT treat that as a failure. Tell the human the amount and what it\'s for, and if they approve, call approve_payment with the intent_id (or reject_payment to decline). On success returns the response body and a payment receipt.',
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL of the paid endpoint to fetch." },
          intent: {
            type: "string",
            description:
              "A short natural-language reason for this payment. Logged in the audit trail and shown to the human if approval is required.",
          },
          max_amount: {
            type: "number",
            description:
              "Optional safety cap. If the server asks for more than this, the call is rejected before any payment is signed.",
          },
        },
        required: ["url", "intent"],
      },
    },
    {
      name: "approve_payment",
      description:
        'Approve a payment that `pay` held for human review (status "approval_required"). Only call this AFTER the human has explicitly confirmed they want to pay. Pass the intent_id from the pay response. Completes the payment and returns the receipt and response body.',
      inputSchema: {
        type: "object",
        properties: {
          intent_id: {
            type: "string",
            description: "The intent_id returned by `pay` when it held the payment for approval.",
          },
        },
        required: ["intent_id"],
      },
    },
    {
      name: "reject_payment",
      description:
        "Decline a payment that `pay` held for human review. Call this when the human declines. Pass the intent_id from the pay response. Nothing is charged.",
      inputSchema: {
        type: "object",
        properties: {
          intent_id: {
            type: "string",
            description: "The intent_id returned by `pay` when it held the payment for approval.",
          },
        },
        required: ["intent_id"],
      },
    },
    {
      name: "audit_query",
      description:
        "Read recent payment events from the audit log. Useful when you need to explain what was paid for, how much was spent today, or why a recent payment behaved a certain way.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of events to return (default 20).",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  // ---------- pay ----------
  if (name === "pay") {
    const url = typeof args.url === "string" ? args.url : "";
    const intent = typeof args.intent === "string" ? args.intent : "";

    // Strict max_amount check. null, NaN, ±Infinity, 0, and negatives must
    // all fail loudly rather than silently drop the cap.
    let maxAmount: number | undefined;
    if (args.max_amount !== undefined && args.max_amount !== null) {
      if (
        typeof args.max_amount !== "number" ||
        !Number.isFinite(args.max_amount) ||
        args.max_amount <= 0
      ) {
        return err(
          "invalid_input",
          `max_amount must be a positive finite number, got: ${JSON.stringify(args.max_amount)}`,
        );
      }
      maxAmount = args.max_amount;
    }

    if (!url || !intent) {
      return err("invalid_input", "url and intent are required");
    }

    try {
      const result = await pay.stage({
        url,
        intent,
        ...(maxAmount !== undefined ? { max_amount: maxAmount } : {}),
      });

      if (result.outcome === "completed") {
        return ok({ receipt: result.intent.receipt, data: result.intent.data });
      }

      if (result.outcome === "rejected") {
        return err("policy_denied", `Payment denied by policy: ${result.reason}`, {
          rule_fired: result.rule_fired,
        });
      }

      // approval_required - hold it and tell the agent to ask the human.
      const { staged } = result;
      pruneExpiredStaged();
      stagedIntents.set(staged.intent_id, { staged, expiresAt: Date.now() + STAGED_TTL_MS });
      return pending({
        status: "approval_required",
        intent_id: staged.intent_id,
        amount: staged.amount,
        currency: staged.currency,
        recipient: staged.recipient_wallet ?? staged.recipient_url,
        rule_fired: staged.rule_fired,
        message: `This payment of ${staged.amount} ${staged.currency} for "${staged.intent}" needs your approval (matched ${staged.rule_fired}). Ask the human to confirm. If they approve, call approve_payment with intent_id "${staged.intent_id}". If they decline, call reject_payment with the same intent_id. Nothing is charged until you call approve_payment.`,
      });
    } catch (caught) {
      if (isBlackteaError(caught)) {
        return err(caught.code, caught.message);
      }
      return err("unknown_error", caught instanceof Error ? caught.message : String(caught));
    }
  }

  // ---------- approve_payment ----------
  if (name === "approve_payment") {
    const intentId = typeof args.intent_id === "string" ? args.intent_id : "";
    if (!intentId) return err("invalid_input", "intent_id is required");

    pruneExpiredStaged();
    const entry = stagedIntents.get(intentId);
    if (!entry) {
      return err(
        "not_found",
        `No payment is awaiting approval with intent_id "${intentId}". It may have expired, already been resolved, or never existed.`,
      );
    }

    try {
      const intent = await pay.complete(entry.staged, "approve");
      stagedIntents.delete(intentId);
      return ok({ receipt: intent.receipt, data: intent.data });
    } catch (caught) {
      // Settle failed (rail down, signature error). The staged intent is
      // consumed either way - a half-failed settle shouldn't be retryable
      // by replaying the same approval.
      stagedIntents.delete(intentId);
      if (isBlackteaError(caught)) {
        return err(caught.code, caught.message);
      }
      return err("unknown_error", caught instanceof Error ? caught.message : String(caught));
    }
  }

  // ---------- reject_payment ----------
  if (name === "reject_payment") {
    const intentId = typeof args.intent_id === "string" ? args.intent_id : "";
    if (!intentId) return err("invalid_input", "intent_id is required");

    pruneExpiredStaged();
    const entry = stagedIntents.get(intentId);
    if (!entry) {
      return err(
        "not_found",
        `No payment is awaiting approval with intent_id "${intentId}". It may have expired or already been resolved.`,
      );
    }

    await pay.complete(entry.staged, "reject");
    stagedIntents.delete(intentId);
    return ok({
      status: "rejected",
      intent_id: intentId,
      message: "Payment declined. Nothing was charged.",
    });
  }

  // ---------- audit_query ----------
  if (name === "audit_query") {
    const limit = typeof args.limit === "number" ? args.limit : 20;

    if (!existsSync(historyPath)) {
      return ok({ events: [], note: `No history file yet at ${historyPath}.` });
    }

    const lines = readFileSync(historyPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const events = tail.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    return ok({ events, count: events.length });
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------- transport ----------

const transport = new StdioServerTransport();
await server.connect(transport);

// Stderr-only banner so the MCP client can see we are up without corrupting
// the stdio protocol on stdout.
console.error(
  `${PACKAGE_NAME} v${VERSION} ready. rail=${useMockRail ? "mock" : "x402"} chain=${chain} policy=${policyPath} history=${historyPath}`,
);
