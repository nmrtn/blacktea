# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other AI coding agents working
in this repo. Read this before making non-trivial changes.

## What this is

`@nmrtn/blacktea` is a TypeScript library that puts spending controls on AI
agents paying online. The library evaluates a policy file against each payment,
approves or denies, optionally asks a human, and writes an audit log. v0.0.x
supports x402 (USDC on Base) as the only payment rail. The architecture is
rail-pluggable so SEPA, ACH, cards, AP2, and ACP can be added later as separate
adapter packages.

Three integration surfaces, one codebase:

- **SDK** - `@nmrtn/blacktea` (`blacktea(opts)` factory). Direct TypeScript import.
- **CLI** - `blacktea` bin in the same npm package. Shell-friendly, for agent
  platforms with shell tools (Claude Code, Cursor, Cline, Aider, OpenClaw,
  Hermes, Devin).
- **MCP server** - `@nmrtn/blacktea-mcp` (separate npm package, lives in
  `mcp-server/`). Stdio JSON-RPC server for Claude Desktop, Cursor chat mode.

User-facing pitch is in `README.md`. Policy DSL semantics live in
`docs/policy-cookbook.md`. Both are the source of truth for user-visible
behavior; the library exists to make them true.

## Commands

```bash
# Root package (@nmrtn/blacktea - SDK + CLI)
npm install
npm test                    # Vitest, mock x402 facilitator, ~10s
npm run typecheck           # tsc --noEmit
npm run build               # tsc + chmod +x dist/cli.js
npm run lint                # biome check .
npm run lint:fix            # biome check --write .

# MCP server (@nmrtn/blacktea-mcp - sibling package)
cd mcp-server
npm install
npm test                    # spawns the built binary, drives JSON-RPC over stdio
npm run typecheck
npm run build
```

Single test file: `npm test -- src/policy/evaluator.test.ts`.
Single test name: `npm test -- -t "rejects sanctioned wallets"`.

`npm test` is required to pass before any PR lands. CI (`.github/workflows/ci.yml`)
runs lint + typecheck + test + build on both packages on every push and PR.

## Architecture

Six pieces. Understand all six before changing any of them.

**1. The factory.** `blacktea(opts)` is the single public entry point. Returns
a `PayFunction` the agent calls for each payment. The factory wires together
the policy evaluator, rail adapters, history store, idempotency cache, audit
sink, and approval callback. Lives in `src/agent.ts`.

**2. Policy schema and evaluator.** Policy is JSON validated by a Zod schema
in `src/policy/schema.ts`. The evaluator walks rules top to bottom, first
match wins, returns a `Decision` of allow / approval / reject. Stateful
operators (`would_spend`, `amount_today_gte`) query the history store. Lives
in `src/policy/`.

**3. Rail adapters.** A `RailAdapter` exposes `name`, `supports(input)`,
`preflight(input)`, `settle(input, requirement, opts)`. The preflight/settle
split mirrors the x402 request-response shape - preflight learns what payment
is required, settle signs and submits. v1 ships only `x402Wallet(cfg)`. Future
rails (SEPA push, cards, AP2, ACP) implement the same interface. Lives in
`src/rails/`.

**4. History store.** File-backed by default. Append-only JSONL at
`./.blacktea/history.jsonl` with an in-memory index loaded at startup. Supports
`sumSince` and `countSince` queries with optional `wallet` and `url` filters.
Swap for Redis or SQLite via the `HistoryStore` interface. Lives in
`src/history/`.

**5. Idempotency store.** LRU with TTL via `lru-cache`. Default 10k entries,
24h TTL. Swap behind the `IdempotencyStore` interface. Lives in
`src/idempotency/`.

**6. PaymentIntent (terminal-state only in v0.0.x).** `pay()` resolves with a
`PaymentIntent` already in a terminal state (`completed`, `denied`, `failed`,
`timed_out`). The async state machine with `onStatusChange` subscriptions is
deferred to a later release. The current `onStatusChange` callback fires once,
synchronously, with the terminal intent. See `src/agent.ts`.

The audit log is a side-channel that records every state transition. Default
sink prints JSON lines to stdout. Customer overrides via the `audit` option on
the factory. The CLI and MCP transports both pass a quiet sink because they
own stdout and audit prints would corrupt the protocol stream.

## Approval channels

v0.0.x ships two approval channels and no HTTP webhook subsystem:

- `console` is a CLI prompt that blocks the agent process. Dev and demo only.
- `callback` invokes the customer's `onApprovalNeeded` async function in-process.
  The customer's function does whatever (Slack, email, dedicated UI, internal
  queue) and returns the decision. Library is dumb on purpose; approval routing
  is the customer's job.

Webhook delivery (library POSTs out to a URL) is on the roadmap but not yet
implemented.

## Things to NOT do

These were considered and explicitly rejected during design. Reverse only with
a strong reason and a written argument.

- Do not add an HTTP webhook server for status delivery. In-process callbacks
  only.
- Do not invent new policy operators ad-hoc. The schema is the source of truth
  (`src/policy/schema.ts`); the cookbook documents every operator
  (`docs/policy-cookbook.md`). Adding an operator means updating both, plus a
  test case.
- Do not let stateful operators query the audit log directly. They go through
  the `HistoryStore` interface. The audit log can be shipped off-machine
  (Datadog, S3) and is not always queryable.
- Do not auto-sort policy rules. The library may warn on suspicious orderings
  but never rewrites the customer's file.
- Do not enable regex in `intent_contains_*` operators. ReDoS risk. Substring
  only.
- Do not bundle a Slack or email integration into the core package. Optional
  `@nmrtn/blacktea-slack` and similar can ship as separate packages.
- Do not log secrets. The audit log captures URL, intent, recipient wallet,
  and amount - never the signing private key. The default audit sink writes
  JSON to stdout, so any future field addition needs to be reviewed against
  this rule.

## Security boundary

The library handles a wallet private key (read from env, typically
`EVM_PRIVATE_KEY`). The key never appears in audit events, error messages,
or test fixtures. The MCP test suite generates an ephemeral key per run via
`crypto.randomBytes(32)`. If you add new logging or error reporting, do not
serialize the key.

The CLI's `--max-amount` flag uses a strict `Number()` parser that exits
with code 7 (`invalid_input`) on non-positive-finite values. Do not relax
this - earlier `Number.parseFloat` + truthy-check version silently dropped
the user-specified cap on bad input. Same hardening applies on the MCP
server's `max_amount` argument.

## Project naming

The npm package is `@nmrtn/blacktea`. The bare `blacktea` name is squatted
on npm by an unrelated package from 2017. Do not chase it without a clear
path to a transfer.

The exported factory is `blacktea(opts)`. The MCP server package is
`@nmrtn/blacktea-mcp`; its bin is `blacktea-mcp`.

## Repo layout

```
src/                  Main library (SDK + CLI)
  agent.ts            blacktea() factory
  cli.ts              CLI entry point
  errors.ts           Typed error classes
  types.ts            Public type definitions
  policy/             Schema, evaluator, loader, decision
  rails/x402.ts       The x402 rail adapter
  history/file-backed.ts
  idempotency/in-memory.ts
  adapters/index.ts   Public re-exports for @nmrtn/blacktea/adapters
test/                 Vitest unit tests mirroring src/
mcp-server/           Separate npm package (@nmrtn/blacktea-mcp)
  src/index.ts        Stdio MCP server
  test/               JSON-RPC integration tests
examples/             Runnable demos
  x402-quickstart/    Local buyer + seller, real Base Sepolia
  agent-sdk-demo/     Claude agent autonomously calling pay()
docs/                 User-facing docs (policy cookbook)
CHANGELOG.md          Release notes for both packages
.github/
  workflows/ci.yml    Lint + typecheck + test + build
  CODEOWNERS          Workflow-edit protection
```
