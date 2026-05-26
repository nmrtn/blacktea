#!/usr/bin/env node
/**
 * blacktea MCP server.
 *
 * Exposes blacktea's pay() function as an MCP tool. Drop one config
 * line into Claude Desktop, Cursor, or any MCP-aware client and the
 * assistant gains a "pay" tool with no extra code.
 *
 * Tools exposed:
 *   pay           Make a paid HTTP request via x402 with policy enforcement
 *   audit_query   Read recent payment audit events from the history file
 *
 * All config via env vars (set by the MCP client when it spawns the
 * server):
 *   EVM_PRIVATE_KEY      required, the wallet's signing key
 *   BLACKTEA_CHAIN       default "base-sepolia"
 *   BLACKTEA_POLICY      path to policy.json, default "./policy.json"
 *   BLACKTEA_HISTORY     path to history.jsonl, default "./.blacktea/history.jsonl"
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { blacktea, isBlackteaError } from "@nmrtn/blacktea";
import { x402Wallet } from "@nmrtn/blacktea/adapters";

const VERSION = "0.0.1";
const PACKAGE_NAME = "@nmrtn/blacktea-mcp";

// ---------- config from env ----------

const pk = process.env.EVM_PRIVATE_KEY;
if (!pk || !pk.startsWith("0x")) {
  console.error(`${PACKAGE_NAME}: EVM_PRIVATE_KEY env var is missing or invalid.`);
  console.error("Set it in your MCP client config under the env block.");
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

const pay = blacktea({
  source: x402Wallet({ privateKey: pk, chain }),
  policy: policyPath,
  audit: () => {
    // The MCP transport owns stdout; any audit prints would corrupt the
    // protocol stream. Stay quiet here. The history file is the audit.
  },
});

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
        "Pay for a paid HTTP resource via x402. The endpoint may charge USDC on Base. Use when you need data from a paywalled API, a premium data feed, or any x402-enabled URL. The blacktea library applies your spending policy before signing; large or unusual payments may require approval. Returns the response body and a payment receipt.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full URL of the paid endpoint to fetch.",
          },
          intent: {
            type: "string",
            description:
              "A short natural-language reason for this payment. Logged in the audit trail and shown to the human if approval is required.",
          },
          max_amount: {
            type: "number",
            description:
              "Optional safety cap. If the server asks for more than this amount, the call fails before any payment is signed.",
          },
        },
        required: ["url", "intent"],
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

  if (name === "pay") {
    const url = typeof args.url === "string" ? args.url : "";
    const intent = typeof args.intent === "string" ? args.intent : "";
    const maxAmount = typeof args.max_amount === "number" ? args.max_amount : undefined;

    if (!url || !intent) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: { code: "invalid_input", message: "url and intent are required" },
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const intentResult = await pay({
        url,
        intent,
        ...(maxAmount !== undefined ? { max_amount: maxAmount } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              receipt: intentResult.receipt,
              data: intentResult.data,
            }),
          },
        ],
      };
    } catch (err) {
      if (isBlackteaError(err)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: { code: err.code, message: err.message },
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: {
                code: "unknown_error",
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "audit_query") {
    const limit = typeof args.limit === "number" ? args.limit : 20;

    if (!existsSync(historyPath)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              events: [],
              note: `No history file yet at ${historyPath}.`,
            }),
          },
        ],
      };
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
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, events, count: events.length }),
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------- transport ----------

const transport = new StdioServerTransport();
await server.connect(transport);

// Stderr-only banner so the MCP client can see we are up without
// corrupting the stdio protocol on stdout.
console.error(`${PACKAGE_NAME} v${VERSION} ready. chain=${chain} policy=${policyPath}`);
