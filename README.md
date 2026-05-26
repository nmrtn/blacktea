# blacktea

[![CI](https://github.com/nmrtn/blacktea/actions/workflows/ci.yml/badge.svg)](https://github.com/nmrtn/blacktea/actions/workflows/ci.yml)

Spending controls for AI agents paying online.

```typescript
import { blacktea } from "@nmrtn/blacktea";
import { x402Wallet } from "@nmrtn/blacktea/adapters";

const pay = blacktea({
  policy: "./policy.json",
  source: x402Wallet({
    privateKey: process.env.AGENT_WALLET_KEY,
    chain: "base-sepolia",
  }),
});

// Small API call. Server asks 4 USDC. Under the policy threshold.
// Library signs the payment, retries, returns the chat completion.
const { data, receipt } = await pay({
  url: "https://api.openai.com/v1/chat",
  intent: "buy GPT-4 tokens",
});
// data is the chat completion. receipt is the payment record.

// Premium dataset. Server asks 1200 USDC. Approval rule fires.
// Your onApprovalNeeded function is called. You tap approve in Slack.
// Library proceeds, returns the dataset.
const { data: dataset } = await pay({
  url: "https://premium-data.example.com/dump",
  intent: "monthly dataset for the analyst agent",
  max_amount: 2000, // safety cap; throws if the server asks for more
});

// Sanctioned recipient. Policy rejects before any payment is sent.
// pay() throws PolicyDeniedError. No money moves.
await pay({
  url: "https://sketchy-api.example.com/access",
  intent: "test",
});
```

## Why this exists

If your agent has a wallet, you have a problem. You cannot sit there watching it. You also cannot let it loose with zero controls.

Today people patch this together themselves with YAML configs, Slack webhooks, and a homemade log. blacktea is one library that does it.

## What it does

- Spending limits. Write a rule for any shape you need: per call, per day, by recipient, by intent, by time of day, anything you can express in the policy DSL.
- Approval flow when a rule says "ask the human first."
- Audit log of every payment, including the agent's own stated reason for spending it.
- Works with x402 today. Architecture is rail-pluggable so AP2, ACP, SEPA, ACH, and card adapters can be added later as separate packages.

## What it does not do

- Pay merchants that do not speak x402 (most of the regular web, in 2026). Wait for AP2 / ACP / SEPA adapters or write your own.
- Issue wallets or hold balances. Bring your own x402-compatible wallet.
- Handle subscriptions or recurring billing.
- Run on the blockchain itself. The library is plain TypeScript, the x402 rail just happens to settle on-chain.

## Install

```bash
npm install @nmrtn/blacktea
```

## Try it

Two runnable examples ship in the repo:

- **`examples/x402-quickstart/`** — a local x402 buyer + seller. End-to-end
  proof the protocol works against Base Sepolia testnet. Requires a Coinbase
  Developer Platform account for testnet funds; the README walks you through
  every step.
- **`examples/agent-sdk-demo/`** — a Claude agent (using the Anthropic API)
  that autonomously decides to call `pay()` to fetch a paywalled API. The
  full lifecycle is visible: tool call, policy evaluation, x402 signing,
  on-chain settlement, response handed back to the model.

The first time we ran the agent demo, Claude settled this transaction
autonomously: [`0x1417b91e...`](https://sepolia.basescan.org/tx/0x1417b91ee70aa8b2b22a1e42b3a247cd2bbedfc531e295d7338fbaf8e83f9165).

## Plug it into your agent

Three integration shapes, same library underneath.

### As a TypeScript SDK (any LLM with tool calling)

`pay()` is a normal async function. Register it as a tool in your LLM
loop, route the tool call into `pay()`, send the returned
`{ data, receipt }` back as the tool result. See
`examples/agent-sdk-demo/demo.ts` for the full Anthropic SDK pattern.

### As a CLI (Claude Code, Cursor, Cline, Aider, OpenClaw, Hermes, Devin)

Any agent platform with shell access can call blacktea directly:

```bash
# Make a paid request
EVM_PRIVATE_KEY=0x... blacktea pay \
  --url https://api.example.com/paid \
  --intent "fetch the report" \
  --max-amount 1

# Inspect what your agent spent
blacktea audit show --last 10

# Sanity-check your policy
blacktea policy validate ./policy.json
blacktea policy test ./policy.json --amount 50 --url https://x.com
```

Output is JSON by default so the agent can parse it; exit codes are
distinct per error class (3=policy denied, 4=approval timeout, etc).
Run `blacktea --help` for the full surface.

### As an MCP server (Claude Desktop, Cursor chat mode)

Drop one block into your MCP-aware client and the assistant gains a
typed `pay` tool with no code on your side:

```json
{
  "mcpServers": {
    "blacktea": {
      "command": "npx",
      "args": ["-y", "@nmrtn/blacktea-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...",
        "BLACKTEA_POLICY": "/path/to/policy.json"
      }
    }
  }
}
```

Restart your client. Ask "use the pay tool to fetch \<some x402 URL\>"
and watch the protocol fire. See [`mcp-server/README.md`](mcp-server/README.md)
for the full setup including Cursor and other clients.

## A policy file looks like this

```json
{
  "rules": [
    { "if": { "wallet_in": "./blocklist.txt" }, "then": { "reject": "sanctioned" } },
    { "if": { "amount_lt": 10 }, "then": { "approve": true } },
    { "if": { "amount_gte": 100 }, "then": { "approval": "console" } }
  ],
  "default": { "approval": "console" }
}
```

More examples in [docs/policy-cookbook.md](docs/policy-cookbook.md).

## Status

Early. v0.1.x. The API will change before 1.0.

If your agent uses x402 and you have felt this pain, open an issue and tell me what your policy needs to look like. That is the single most useful thing anyone can do right now.

## Why open source

Open source means you do not have to trust me. The code is right there. If something does not fit, patch it. Or skip me entirely and host the whole thing on your own machine.

## License

MIT. Do what you want.

## Credits

Built mostly with [Claude Code](https://claude.com/claude-code). Inspired by talking to people who hand-rolled this themselves and got tired of it.
