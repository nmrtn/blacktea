# blacktea

[![CI](https://github.com/nmrtn/blacktea/actions/workflows/ci.yml/badge.svg)](https://github.com/nmrtn/blacktea/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40nmrtn%2Fblacktea?label=%40nmrtn%2Fblacktea)](https://www.npmjs.com/package/@nmrtn/blacktea)
[![npm](https://img.shields.io/npm/v/%40nmrtn%2Fblacktea-mcp?label=%40nmrtn%2Fblacktea-mcp)](https://www.npmjs.com/package/@nmrtn/blacktea-mcp)

Spending controls for AI agents paying online.

```typescript
import { blacktea } from "@nmrtn/blacktea";
import { x402Wallet } from "@nmrtn/blacktea/adapters";

const pay = blacktea({
  policy: "./policy.json",
  source: x402Wallet({
    privateKey: process.env.EVM_PRIVATE_KEY,
    chain: "base-sepolia",
  }),
});

// Small paid API call. Server asks 4 USDC, under the policy threshold.
// blacktea signs the x402 payment, retries, returns the data.
const { data, receipt } = await pay({
  url: "https://api.example.com/v1/inference",
  intent: "premium model inference for the research agent",
});
// data is the API response. receipt is the payment record.

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

## Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Demo](#demo)
- [Install](#install)
- [Try it in 30 seconds](#try-it-in-30-seconds-no-wallet-needed)
- [Try it for real](#try-it-for-real)
- [Plug it into your agent](#plug-it-into-your-agent) (SDK, CLI, MCP)
- [Policy files](#a-policy-file-looks-like-this)
- [Rails](#rails)
- [Contributing](#contributing)

## Why this exists

If your agent has a wallet, you have a problem. You cannot sit there watching it. You also cannot let it loose with zero controls.

Today people patch this together themselves with YAML configs, Slack webhooks, and a homemade log. blacktea is one library that does it.

## What it does

- Spending limits. Write a rule for any shape you need: per call, per day, by recipient, by intent, by time of day, anything you can express in the policy DSL.
- Approval flow when a rule says "ask the human first."
- Audit log of every payment, including the agent's own stated reason for spending it.
- Works with x402 today (an open protocol for paying for HTTP resources with stablecoins, USDC on Base). Architecture is rail-pluggable so AP2, ACP, SEPA, ACH, and card adapters can be added later as separate packages.

## Demo

<p align="center">
  <img src="docs/demo.gif" width="300" alt="blacktea demo: a personal agent asks before it spends, then settles on-chain after you approve" />
</p>

A personal agent (Hermes, over Telegram) is asked to buy a paid report.
blacktea holds the payment, the agent asks for approval in the chat, and
only after you say "yes" does it settle: 0.01 USDC on Base Sepolia. That
settlement is real and verifiable on-chain:
[`0x11f759ad…`](https://sepolia.basescan.org/tx/0x11f759ad2f5dc6c7153454ab75c00e85f2791ea4aa6388ea47e76a19ed4632a3).

## Install

```bash
npm install @nmrtn/blacktea
```

## Try it in 30 seconds, no wallet needed

A `mockWallet` adapter ships in the same package. No x402 server, no USDC,
no testnet. Useful for trying the policy engine end to end before wiring
up a real wallet.

```typescript
import { blacktea } from "@nmrtn/blacktea";
import { mockWallet } from "@nmrtn/blacktea/adapters";

const pay = blacktea({
  policy: "./policy.json",
  source: mockWallet({ amount: 0.5 }), // pretend the server asks for 0.5 USDC
});

const intent = await pay({
  url: "https://example.com/api",
  intent: "smoke test the policy",
});

console.log(intent.receipt);
// { id: "mock_<ts>", amount: 0.5, currency: "USDC", rail: "mock",
//   simulated: true, ... }
```

The receipt is marked `simulated: true`. The audit log still writes. The
policy engine still fires. Approval callbacks still get called. Swap
`mockWallet` for `x402Wallet` when you're ready to spend real money.

## Try it for real

Two runnable examples ship in the repo:

- **`examples/x402-quickstart/`**: a local x402 buyer + seller. End-to-end
  proof the protocol works against Base Sepolia testnet. Requires a Coinbase
  Developer Platform account for testnet funds; the README walks you through
  every step.
- **`examples/agent-sdk-demo/`**: a Claude agent (using the Anthropic API)
  that autonomously decides to call `pay()` to fetch a paywalled API. The
  full lifecycle is visible: tool call, policy evaluation, x402 signing,
  on-chain settlement, response handed back to the model.

The first time we ran the agent demo, Claude settled this transaction
autonomously: [`0x1417b91e...`](https://sepolia.basescan.org/tx/0x1417b91ee70aa8b2b22a1e42b3a247cd2bbedfc531e295d7338fbaf8e83f9165).

## Plug it into your agent

Three integration shapes, same library underneath. The reason all three
ship in one package rather than three separate projects: spending policy
belongs in one place. If your agent talks to you through a chat MCP, runs
a shell-mode CLI from Claude Code, AND has a TypeScript runtime calling
`pay()` directly, you want one policy.json governing all of them. One
audit log. One source of truth for "what is this agent allowed to spend?"
Splitting that across three libraries is the bug.

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

### As an MCP server (Claude Desktop, Cursor, OpenClaw, Hermes)

Drop one block into your MCP-aware client and the assistant gains
`pay`, `approve_payment`, `reject_payment`, and `audit_query` tools with
no code on your side:

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

Restart your client. Ask "use blacktea to fetch \<some x402 URL\>" and
watch the protocol fire. See [`mcp-server/README.md`](mcp-server/README.md)
for OpenClaw, Hermes, and Cursor setup.

**Ask-before-spending, in the chat.** When a payment exceeds your
auto-approve limit, the agent does not pay and does not fail. It asks you
right there in the conversation ("this costs 2.50 USDC, approve?") and
only settles after you say yes (it calls `approve_payment` under the
hood). Below the limit, it just pays. Over your hard limit, it refuses.
The human stays in the loop without leaving the chat.

**Try it with no wallet.** Set `BLACKTEA_RAIL=mock` and the server runs
against a simulated merchant: no x402 endpoint, no USDC, no signing.
`BLACKTEA_MOCK_AMOUNT` sets the price so you can watch auto-approve,
ask-first, and reject all fire against your policy before you wire a real
wallet.

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

## Not for

- Issuing wallets or holding balances. Bring your own wallet for whichever
  rail you're using.
- Subscriptions or recurring billing.
- The seller side of x402. blacktea is buyer-side: it protects the agent
  with the wallet, not the API accepting payments. Use `x402-express` or
  similar for the seller.

## Rails

| Rail | Status | Package |
|---|---|---|
| **x402** (USDC on Base) | Shipped | `@nmrtn/blacktea/adapters` |
| **mock** (no network) | Shipped | `@nmrtn/blacktea/adapters` |
| AP2 | Planned, design open | n/a |
| ACP | Planned, design open | n/a |
| SEPA push | Planned, design open | n/a |
| ACH | Planned, design open | n/a |
| Cards (Stripe Issuing auth-webhook) | Planned, deferred to v1.5+ | n/a |

The `RailAdapter` interface is two methods (`preflight`, `settle`) plus
`name` and `supports`. Adding a rail is a separate adapter package; the
core never changes. See `src/rails/x402.ts` for the reference shape and
`src/rails/mock.ts` for the no-network version.

If you maintain or care about any of the planned rails: open an issue
describing the shape (request-response? push? webhook-driven?) and what
the receipt should carry. Real input from someone using the rail beats
spec reading every time.

## Contributing

Contributions welcome. Three high-value places to land work right now:

- **Rail adapters.** If you want SEPA, ACP, AP2, or a custom rail, the
  interface is small and the existing `x402Wallet` shows the pattern. A
  rail can ship as a sibling npm package (like `@nmrtn/blacktea-mcp`) or
  go in `src/rails/` if it's broadly useful.
- **Policy DSL feedback.** The DSL is the part most likely to change.
  Open an issue with the rule shape your agent actually needs.
- **Bug reports with reproducible cases.** Stack trace, version,
  minimal policy.json that triggers it. The faster a bug is reproducible
  the faster it gets fixed.

To get set up locally:

```bash
git clone https://github.com/nmrtn/blacktea.git
cd blacktea
npm install
npm test          # 166 tests, ~10s
npm run lint
npm run typecheck
npm run build
```

The MCP server is a sibling package in `mcp-server/`. It depends on the
main library; build the main library first, then `cd mcp-server && npm
install && npm test`.

Code style is enforced by Biome (`npm run lint:fix` formats automatically).
Tests use Vitest. CI runs everything on every push and PR.

For bigger design questions (a new policy operator, a new rail, a
breaking change), open an issue first. Better to argue about the shape
in a thread than in a PR review.

## Status

Early. v0.1.x. The API will change before 1.0. Lockstep with feedback
from real users; if your agent uses x402 and you have felt this pain,
open an issue.

## License

MIT. Do what you want.
