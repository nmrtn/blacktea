/**
 * Claude Agent SDK demo (T9).
 *
 * What happens:
 *   1. We wire blacktea up with the x402 wallet and a small policy.
 *   2. We tell Claude it has a "pay" tool that fetches paid resources.
 *   3. We give Claude a natural-language task.
 *   4. Claude decides to call pay(). The runtime routes that call to
 *      blacktea, which preflights, evaluates the policy, signs the
 *      x402 payment, settles on Base Sepolia, returns the data.
 *   5. Claude reads the data, answers in plain English.
 *
 * Prereq: the x402-quickstart seller must be running on localhost:4021.
 * That is the URL Claude will be asked to fetch.
 *
 * Run with:  npm run demo
 */

import Anthropic from "@anthropic-ai/sdk";
import { blacktea } from "@nmrtn/blacktea";
import { x402Wallet } from "@nmrtn/blacktea/adapters";
import dotenv from "dotenv";

dotenv.config();

const evmKey = process.env.EVM_PRIVATE_KEY;
if (!evmKey || !evmKey.startsWith("0x")) {
  console.error("Missing EVM_PRIVATE_KEY in .env. See .env.example.");
  process.exit(1);
}

const targetUrl = process.env.TARGET_URL ?? "http://localhost:4021/protected";

// ---------- wire blacktea ----------

const pay = blacktea({
  source: x402Wallet({
    privateKey: evmKey,
    chain: "base-sepolia",
  }),
  policy: "./policy.json",
  audit: (e) => {
    // Quiet audit sink that prints one line per event so you can watch
    // the policy + rail flow in real time.
    console.log(`  [blacktea] ${e.event} ${JSON.stringify(e.data)}`);
  },
});

// ---------- describe the tool to Claude ----------

const tools = [
  {
    name: "pay",
    description:
      "Fetch a paid HTTP resource. The endpoint may charge USDC via the x402 protocol. Use this when you need data behind a paywall, a premium API, or any x402-enabled URL. Returns the response body. blacktea handles policy, approval, and signing internally; you just request the URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The full URL of the paid endpoint to fetch.",
        },
        intent: {
          type: "string",
          description:
            "A short natural-language reason for this payment. This is logged in the audit trail and shown to the human if approval is required.",
        },
        max_amount: {
          type: "number",
          description:
            "Optional safety cap in USDC. If the server asks for more, the call fails before any payment is signed.",
        },
      },
      required: ["url", "intent"],
    },
  },
];

// ---------- agent loop ----------

const anthropic = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface TextBlock {
  type: "text";
  text: string;
}
type ContentBlock = ToolUseBlock | TextBlock;

async function runAgent(userMessage: string): Promise<void> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`USER: ${userMessage}`);
  console.log(`${"=".repeat(72)}\n`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  while (true) {
    const reply = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools,
      messages,
    });

    const blocks = reply.content as ContentBlock[];

    // Print any text Claude returned this turn.
    for (const block of blocks) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\nCLAUDE: ${block.text}\n`);
      }
    }

    if (reply.stop_reason !== "tool_use") {
      // Claude is done.
      return;
    }

    // Carry Claude's reply into the message history so it can see its own
    // tool_use block when we send the tool_result back.
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      if (toolUse.name !== "pay") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      const args = toolUse.input as { url: string; intent: string; max_amount?: number };
      console.log(`\n>>> Claude is calling pay(${JSON.stringify(args)})\n`);

      try {
        const intent = await pay(args);
        console.log(
          `\n<<< pay() returned. tx=${intent.receipt?.rail_charge_id ?? "(none)"}, data size=${
            typeof intent.data === "string" ? intent.data.length : JSON.stringify(intent.data ?? "").length
          } bytes\n`,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ data: intent.data, receipt: intent.receipt }),
        });
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.log(`\n<<< pay() threw: ${message}\n`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: message,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ---------- the prompt that drives the demo ----------

const prompt = `You are an autonomous agent helping me research a paywalled API.
Please fetch the contents of ${targetUrl} for me. It charges a tiny amount of USDC via x402. After you get the response, summarize what was returned.`;

await runAgent(prompt);
