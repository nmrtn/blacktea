# LAUNCH.md

Self-contained playbook for taking blacktea from v0.0.1 (shipped) to a real
public launch. Pick up where you left off without re-asking questions.

---

## Status as of last edit (2026-05-26)

```
v0.0.1                  published to npm at @nmrtn/blacktea
GitHub repo             https://github.com/nmrtn/blacktea (public, CI green)
Tag v0.0.1              pushed
README                  current; mentions npm install, both examples, real tx
Examples                two, both verified to run end-to-end
Tests                   132 passing
On-chain proof          https://sepolia.basescan.org/tx/0x1417b91ee70aa8b2b22a1e42b3a247cd2bbedfc531e295d7338fbaf8e83f9165
```

What is missing for a maximum-reach launch:

```
CLI surface             not built. Most code-focused agent platforms
                        (Claude Code, Cursor, Cline, Aider, OpenClaw,
                        Hermes) can shell out to invoke a CLI. Lower
                        friction than wiring blacktea in code.
MCP server              not built. Required to reach Claude Desktop,
                        Cursor chat mode, and other sandboxed
                        assistants. Larger absolute audience.
Launch post             not written. The single biggest lever for
                        day-one adoption.
Submissions             not done. Awesome lists, Discord drops,
                        community pings.
```

This file walks through each.

---

## Phase 1: v0.0.2 (CLI release)

Reach: code-focused agent platforms (Claude Code, Cursor, Cline, Aider,
OpenClaw, Hermes, Devin) + human developers debugging their config.

Cost: ~1 hour.

### Steps

```
Step 1 (~5 min)   Add CLI bin to root package.json
                  - "bin": { "blacktea": "./dist/cli.js" }
                  - The CLI script is built from src/cli.ts

Step 2 (~5 min)   Add commander as a dependency
                  - npm install commander

Step 3 (~30 min)  Write src/cli.ts with three commands

                  pay --url <url> --intent <text> [--max-amount N]
                       [--policy path] [--source-key env-var-name]
                  - Reads the wallet key from EVM_PRIVATE_KEY (or
                    --source-key)
                  - Loads policy from --policy or ./policy.json
                  - Builds blacktea() inline, calls pay()
                  - Prints { receipt, data } as JSON (machine-readable
                    so agents can parse it cleanly)
                  - Non-zero exit on PolicyDeniedError etc

                  audit show [--last N] [--json] [--store path]
                  - Reads .blacktea/history.jsonl (or --store)
                  - Pretty table by default; --json for machine parse

                  policy validate <path>
                  - Loads, runs PolicySchema.safeParse
                  - Prints "valid" or formatted issues with locations

                  policy test <path> --amount N --url U [--intent S]
                  - Builds a fake PaymentIntentInput
                  - Runs evaluatePolicy against the loaded policy
                  - Prints the Decision (allow / approval / reject)
                    plus which rule fired

Step 4 (~10 min)  Tests for each command
                  - Import command functions (not the bin)
                  - Spawn the binary in one smoke test

Step 5 (~5 min)   Update README
                  - "CLI" subsection after the SDK example
                  - Three runnable command examples
                  - One line for each agent integration:
                    "Claude Code / Cursor / Cline / OpenClaw / Hermes
                    can call this directly via their shell tool"

Step 6 (~5 min)   Bump to 0.0.2, build, publish
                  - npm version patch  (creates a commit and tag)
                  - npm run build
                  - npm publish --access public --otp=XXXXXX
                  - git push --tags

Smoke test it works (~5 min)
                  - In a fresh dir:
                      mkdir /tmp/bt-test && cd /tmp/bt-test
                      npx @nmrtn/blacktea pay --help
                  - Should print the help text without errors
                  - Asks Claude Code: "use the blacktea CLI to fetch
                    http://localhost:4021/protected with intent 'test'"
                    (with quickstart seller running)
                  - Claude should figure it out via --help, run the
                    command, parse the JSON output
```

---

## Phase 2: v0.0.3 (MCP server)

Reach: Claude Desktop, Cursor in chat mode, any MCP-aware client. Larger
absolute audience than Phase 1 but a different one.

Cost: ~1.5 hours.

### Steps

```
Step 1 (~10 min)  Scaffold a new package directory
                  mcp-server/
                    package.json
                      name: @nmrtn/blacktea-mcp
                      bin: { "blacktea-mcp": "./dist/index.js" }
                      deps: @modelcontextprotocol/sdk, @nmrtn/blacktea
                    tsconfig.json
                    src/index.ts
                    README.md

Step 2 (~30 min)  Build mcp-server/src/index.ts
                  - Reads env vars at startup:
                      EVM_PRIVATE_KEY      (required)
                      BLACKTEA_CHAIN       (default: base-sepolia)
                      BLACKTEA_POLICY      (path, default: ./policy.json)
                      BLACKTEA_HISTORY     (path, default: ~/.blacktea/history.jsonl)
                  - Instantiates blacktea() once
                  - Uses @modelcontextprotocol/sdk's Server class
                  - Registers tools:
                      pay                  same schema as agent-sdk-demo
                      audit_query          read history
                      policy_describe      dump policy in plain English
                  - Runs on stdio transport (process.stdin/stdout)

Step 3 (~20 min)  Test against Claude Desktop
                  - In ~/Library/Application Support/Claude/
                    claude_desktop_config.json:
                        {
                          "mcpServers": {
                            "blacktea": {
                              "command": "node",
                              "args": ["/abs/path/to/mcp-server/dist/index.js"],
                              "env": {
                                "EVM_PRIVATE_KEY": "0x...",
                                "BLACKTEA_POLICY": "/abs/path/to/policy.json"
                              }
                            }
                          }
                        }
                  - Restart Claude Desktop
                  - Ask Claude: "use the pay tool to fetch
                    http://localhost:4021/protected"
                  - Watch the tool appear and run

Step 4 (~15 min)  Write mcp-server/README.md
                  - npx install pattern
                  - Claude Desktop config example
                  - Cursor config example
                  - List of tools exposed
                  - Link back to @nmrtn/blacktea

Step 5 (~5 min)   Publish to npm
                  - cd mcp-server && npm publish --access public --otp=XXXXXX

Step 6 (~10 min)  Update main README
                  - Replace "MCP on the v0.2 roadmap" with a working
                    config snippet
                  - Add an "MCP" subsection next to "CLI"

Smoke test (~10 min)
                  - npx @nmrtn/blacktea-mcp prints stdio noise (working)
                  - Claude Desktop sees the tools (working)
                  - End-to-end ask Claude Desktop to fetch a paid URL
```

---

## Phase 3: v0.1.0 (the launch version)

Once Phase 1 (CLI) and Phase 2 (MCP) ship, the library covers every
reasonable agent integration path. Bump to v0.1.0 to signal "first real
release" and launch.

### Steps

```
Step 1 (~10 min)  Final README polish for v0.1.0
                  - Three integration examples side by side:
                      SDK (existing), CLI (new), MCP (new)
                  - Update the "Plug it into your agent" section to
                    show all three with subheadings
                  - Add the npm version badge:
                      [![npm](https://img.shields.io/npm/v/@nmrtn/blacktea.svg)](https://www.npmjs.com/package/@nmrtn/blacktea)
                  - Make sure the on-chain link still works

Step 2 (~5 min)   CHANGELOG.md for v0.1.0
                  - "v0.1.0 - first real release"
                  - Bullet list: SDK, CLI, MCP, x402 rail, policy DSL
                  - Note: API may still shift before v1.0

Step 3 (~5 min)   Bump version
                  - npm version minor (0.0.2 -> 0.1.0)
                  - Commits, tags, pushes

Step 4 (~5 min)   Publish
                  - npm publish --access public

Step 5            Launch post (see below)
```

---

## Launch posts

Write all three before you publish anywhere. Order of posting:
HN first, X 30 min later, Reddit 2 hours later. Reasoning: HN has the
strictest "no self-promotion" vibes and works best with fresh attention;
X gets boosted by the HN traffic; Reddit converts the long-tail.

### Hacker News (Show HN)

Title: `Show HN: blacktea, open source spending controls for AI agents that pay online`

Body:

```
I built an open source TypeScript library that puts spending controls
around AI agents that pay for things. Repo:
https://github.com/nmrtn/blacktea . npm: @nmrtn/blacktea .

The problem: if you give an AI agent a wallet, it will spend it. There
is no good way today to set "don't spend over 100 USDC in a day," "ask
me first for anything over 50," or "never pay this list of addresses."
People hand-roll it with Stripe spending limits, Slack webhooks, and a
homemade audit log.

blacktea is one library that does all three. You write a policy JSON
file. Every payment runs through it. Approval flows go to a function
you register. Audit log writes to a file (or wherever).

Concrete proof: I gave Claude a "pay" tool and asked it to fetch a
paywalled API. It autonomously decided to pay, the library ran the
policy, signed the x402 stablecoin payment, settled on Base Sepolia,
and handed the data back to Claude. Real tx on chain:

https://sepolia.basescan.org/tx/0x1417b91ee70aa8b2b22a1e42b3a247cd2bbedfc531e295d7338fbaf8e83f9165

v0.0.1 ships x402 only. The rail architecture is pluggable; AP2, ACP,
SEPA, ACH, and card adapters are future work. Policy DSL covers 10
operators (amount caps, rolling windows by recipient, time of day,
intent string match, sanctions list, allowlist, etc).

132 tests, lint and typecheck clean, MIT licensed, no telemetry, no
account required. Just npm install.

I would love feedback on the policy DSL specifically (docs/policy-
cookbook.md). If you have an agent that handles money today, I want to
know what your policy needs to look like.
```

### X / Twitter (single thread)

Tweet 1 (the hook):

```
I asked Claude to fetch a paywalled API. It autonomously paid 0.01 USDC
through a library I just open sourced, with policy + audit running over
it. On-chain proof: [Basescan link]

npm install @nmrtn/blacktea

repo: github.com/nmrtn/blacktea
```

Tweet 2 (the why):

```
Agents are starting to hold wallets. Today there is no good way to say
"don't spend more than €100 a day" or "ask me first for anything over
€50" without hand-rolling it with Stripe controls and Slack webhooks.

blacktea is that layer, in one library.
```

Tweet 3 (the demo screenshot):

```
[screenshot of the demo terminal output]
[screenshot of the Basescan transaction]
```

Tweet 4 (the call to action):

```
v0.0.1, x402 only, MIT. Pluggable architecture for SEPA / AP2 / ACP /
cards in v0.x.

If you build agents that move money, I want to see your policy file.
Open an issue, DM me, or just steal it. github.com/nmrtn/blacktea
```

### Reddit (multiple subreddits)

Cross-post to:
- r/LocalLLaMA (large, technical, friendly to OSS)
- r/AI_Agents (smaller but on-topic)
- r/ethdev (crypto-side audience)

Title: `I open sourced spending controls for AI agents that pay online (x402, MIT)`

Body: same shape as the HN post but slightly shorter. Reddit prefers a
concise tl;dr at the top.

### Anthropic / Coinbase / x402 Discords

Drop a short note in #showcase or #builders channels:

```
Hi all, just shipped @nmrtn/blacktea - open source spending controls
for AI agents that pay via x402. Includes a working Claude Agent SDK
demo where Claude autonomously paid for an API call. Feedback welcome:

repo: github.com/nmrtn/blacktea
npm: npm install @nmrtn/blacktea
```

Do NOT cross-post the same exact text on every channel. Tailor the
first sentence to the community.

---

## Submission targets (do these before or right after the launch posts)

Each one is a PR with a short blacktea entry. Each gives you a
permanent backlink and discovery surface.

```
1. github.com/x402-foundation/x402
   - Their README or docs may have a "implementations" or "ecosystem"
     section. Submit a PR adding blacktea.

2. github.com/coinbase/x402
   - Same. They have an examples/ folder. Worth adding blacktea as a
     buyer-side library example.

3. Search GitHub for "awesome-x402"
   - If a list exists, PR to add yourself.
   - If not, consider creating awesome-x402 as a sibling project.

4. github.com/punkpeye/awesome-mcp-servers  (when MCP ships)
   - Submit @nmrtn/blacktea-mcp after Phase 2.

5. Search for "awesome-llm-agents" / "awesome-ai-agents"
   - PR to add blacktea.

6. github.com/anthropics/anthropic-cookbook (if blacktea-mcp ships)
   - Maybe a notebook showing the integration. Larger ask.
```

---

## Day 1-7 playbook

```
Day 0 (the day you post)
  - 9:00 local time  HN post live (best HN traffic window is morning PT)
  - 9:30 local time  X thread live, drives back to HN
  - 11:00            Reddit cross-posts
  - 14:00            Discord drops
  - Watch GitHub notifications all day. Reply to every comment within
    a few hours. Politeness multiplies signal.

Day 1
  - Check GitHub Insights -> Traffic. Note top referrers.
  - Reply to any issues opened overnight.
  - If anyone asks about a use case you did not consider, write it down.
    Do not over-promise.

Day 2-3
  - Write a short follow-up blog post / X thread about something you
    learned from day 1 feedback. Examples:
    - "What people actually asked about blacktea on day 1"
    - "The policy DSL question that keeps coming up"
  - Send the Panche DM if you haven't yet (draft in the design doc).

Day 4-7
  - Cross-reference: do GitHub code search for `from "@nmrtn/blacktea"`.
    Find any real users. Reach out to two of them with a one-line "what
    are you building?" message.
  - Submit to any awesome lists you have not yet hit.
  - If you have momentum, start Phase 2 (MCP). If not, rest.

End of week 1
  - Take stock. npm weekly downloads, stars, issues opened.
  - Decide what to ship in v0.1.1 based on what users actually asked for.
  - Do not ship "v1.0" or commit to any breaking change cadence yet.
```

---

## Monitoring setup (one-time, 5 minutes)

```
1. GitHub: click the Watch button on the repo, "All Activity"
2. F5Bot at https://f5bot.com - keyword "blacktea"
3. Google Alert for "@nmrtn/blacktea"
4. Bookmark these five URLs (check daily for the first week):
     https://www.npmjs.com/package/@nmrtn/blacktea
     https://github.com/nmrtn/blacktea
     https://github.com/nmrtn/blacktea/pulse
     https://github.com/nmrtn/blacktea/graphs/traffic
     https://star-history.com/#nmrtn/blacktea
5. Pin the launch post in your X profile after it goes live
```

---

## What "good day 1" looks like

```
HN post:        15-50 upvotes is fine for a niche dev tool
                100+ is real traction
                500+ is front page

X thread:       20-100 likes is fine for a first-time launch from a
                no-following account
                Look at retweets more than likes; one repost by an
                influential agent-builder beats 100 random likes

GitHub:         5-50 stars day 1 is healthy
                20-200 unique clones day 1 is healthy
                3+ issues from strangers within week 1 means people
                actually tried it

npm:            5-50 weekly downloads first week is fine; mostly bots
                Watch for the second-week curve; if downloads keep
                climbing in week 2, the launch landed
```

If day 1 is quieter than this, do not panic. Many great projects had
quiet launches. The signal that matters is whether anything builds
week over week.

---

## Things to avoid

```
- Self-upvoting on HN (account ban risk)
- Begging for stars in Discord
- Asking friends to leave fake testimonials
- Picking fights with AsterPay / AgentaOS or any other player; they
  are not your enemies, they are validating the market
- Shipping v1.0 before you have real user feedback
- Building features speculatively for users who have not asked
- Responding to criticism with defensiveness
- Promising deadlines on rails (SEPA, cards) you have not started
```

---

## When to stop reading this file

When you have:

- Published v0.0.2 (CLI)
- Published v0.0.3 (MCP)
- Published v0.1.0 (the launch version)
- Posted on HN, X, Reddit
- Submitted to at least 3 awesome lists / external indexes
- Replied to every issue opened in the first 7 days

Then this file is done. v0.1.1+ is informed by real users, not by this
plan.
