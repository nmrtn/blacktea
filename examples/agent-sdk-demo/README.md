# Claude Agent SDK demo

A Claude agent autonomously pays for an x402-enabled API call through
blacktea, then summarizes the response.

What this proves: an LLM agent can decide to spend money on its own, and
blacktea sits between the decision and the wallet, applying policy and
recording an audit log.

## Prereqs

1. **The x402-quickstart seller must be running.** In another terminal:
   ```bash
   cd ../x402-quickstart
   npm run seller
   ```
   It needs to be on port 4021 (the default).

2. **An `EVM_PRIVATE_KEY` with Base Sepolia funds.** Reuse the key from
   the quickstart's `.env`. The wallet must hold ETH (for gas) and USDC.

3. **An Anthropic API key.** If `ANTHROPIC_API_KEY` is already in your
   shell env (Claude Code users almost certainly have it), nothing else
   is needed. Otherwise, add it to your `.env`.

## Run it

```bash
cp .env.example .env
# edit .env: paste EVM_PRIVATE_KEY (from the quickstart)
# optionally: paste ANTHROPIC_API_KEY if it is not in your shell

npm install
npm run demo
```

## What you should see

```
========================================================================
USER: You are an autonomous agent helping me research a paywalled API.
Please fetch the contents of http://localhost:4021/protected ...
========================================================================

CLAUDE: I'll fetch that for you. The endpoint charges via x402.

>>> Claude is calling pay({"url":"http://localhost:4021/protected","intent":"..."})

  [blacktea] intent_created  ...
  [blacktea] rail_chosen  {"rail":"x402"}
  [blacktea] preflight_received  {"amount":0.01,...}
  [blacktea] policy_evaluated  {"decision":"allow","rule_fired":"rule[1]"}
  [blacktea] rail_called  {"rail":"x402"}
  [blacktea] payment_completed  {"rail":"x402","charge_id":"0xeba79..."}

<<< pay() returned. tx=0xeba79..., data size=68 bytes

CLAUDE: I successfully fetched the endpoint. It returned a JSON
response with `message: "Hello, paid customer."` and a timestamp. The
0.01 USDC payment settled on Base Sepolia in transaction 0xeba79...
```

The full lifecycle is visible. Claude decides, blacktea enforces, x402
settles, Claude reports.

## Policy in play

The `policy.json` here:

```json
{
  "rules": [
    { "if": { "amount_gte": 5 },   "then": { "reject": "absolute_cap_5_usdc" } },
    { "if": { "amount_lt": 0.1 },  "then": { "approve": true } },
    { "if": { "amount_gte": 0.1 }, "then": { "approval": "console" } }
  ],
  "default": { "approval": "console" }
}
```

The quickstart seller charges 0.01 USDC. That falls under the
`amount_lt: 0.1` rule and auto-approves. Try changing the policy to
require approval (e.g. drop the threshold) and re-run to watch the
console prompt.

## The "shoes" demo

For the "Hey agent, find me running shoes" scenario from the README
roadmap, you need either (a) a merchant that accepts x402 or (b) a card
rail adapter. Neither exists in v0.1. This demo proves the agent
plumbing works against any x402-enabled URL today.
