# blacktea

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

// €4 for an OpenAI call. Under the daily limit. Just pays.
await pay({
  amount: 4,
  url: "https://api.openai.com/v1/chat",
  intent: "buy GPT-4 tokens",
});

// €1,200 for premium data. The approval rule fires.
// Your phone buzzes with the agent's reason. Tap to approve.
await pay({
  amount: 1200,
  url: "https://premium-data.example.com/dump",
  intent: "monthly dataset for the analyst agent",
});

// €50 to a sanctioned wallet. Never happens.
await pay({
  amount: 50,
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
