# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## State of the repo

Pre-code. Only `README.md`, `docs/policy-cookbook.md`, and this file exist as of 2026-05-26. The library has been fully designed but not yet implemented. The first coding task is project scaffolding followed by T2 (the policy schema). See the design doc location below for the full architecture, the 12-task implementation list, and the rationale behind every choice.

The full architecture and history of decisions lives at:

```
~/.gstack/projects/blacktea/nmrtn-agent-payments-design-20260522.md
~/.gstack/projects/blacktea/nmrtn-agent-payments-eng-review-test-plan-20260522.md
~/.gstack/projects/blacktea/tasks-eng-review-20260522.jsonl
```

These files live outside the repo on purpose (project artifacts, not source). Read them before making large architectural changes.

## What this is

`@nmrtn/blacktea` is a TypeScript library that puts spending controls on AI agents paying online. The library evaluates a policy file against each payment, approves or denies, optionally asks a human, and writes an audit log. v1 supports x402 (USDC on Base) as the only payment rail. The architecture is rail-pluggable so SEPA, ACH, cards, AP2, and ACP can be added later as separate adapter packages.

User-facing pitch is in `README.md`. Policy DSL semantics are in `docs/policy-cookbook.md`. Both are the source of truth for user-visible behavior. The library's job is to make them true.

## Commands (planned, not yet scaffolded)

Once scaffolded the repo expects:

- `npm install` (or `bun install`). Choose one. Bun is faster but npm is more familiar to outside contributors. README install line will reflect the choice.
- `npm test` runs Vitest unit and integration tests with the in-process mock x402 facilitator.
- `npm run test:e2e` runs end-to-end tests against real Base Sepolia testnet (nightly and on release tag, not on every PR).
- `npm run build` runs `tsc -p tsconfig.build.json`.
- `npm run lint` runs ESLint or Biome (pick one during scaffolding, document it here).
- `npm run typecheck` runs `tsc --noEmit`.
- `npx @nmrtn/blacktea-demo` runs the Claude Agent SDK demo against the mock facilitator.

To run a single test file: `npm test -- src/policy/evaluator.test.ts`. To run a single test: `npm test -- -t "rejects sanctioned wallets"`.

## Architecture, big picture

The library has six pieces. A future Claude session should understand all six before changing any of them.

**1. The factory.** `blacktea(opts)` is the single public entry point. It returns a `PayFunction` the agent calls for each payment. The factory wires together the policy evaluator, rail adapters, history store, idempotency cache, audit sink, and approval callback. Lives in `src/agent.ts`.

**2. Policy schema and evaluator.** Policy is JSON validated by a standalone JSON Schema (`schemas/policy.schema.json`) which is the source of truth. Zod types are derived from it. The evaluator walks rules top to bottom, first match wins, and returns a `Decision` of allow, approval, or reject. Stateful operators (`would_spend`, `amount_today_gte`) query the history store. Lives in `src/policy/`.

**3. Rail adapters.** A `RailAdapter` exposes `name`, `supports(input)`, `estimate(input)`, `pay(input, opts)`. v1 ships only `x402Wallet(cfg)` which builds an adapter over Coinbase's x402 protocol on Base. Future rails (SEPA push, cards, AP2, ACP) implement the same interface and slot in without core changes. Lives in `src/rails/`.

**4. History store.** File-backed by default. Append-only JSONL at `./.blacktea/history.jsonl` with an in-memory index loaded at startup. Supports `sumSince` and `countSince` queries with optional `wallet` and `url` filters. Customer can swap for Redis or SQLite via the `HistoryStore` interface. Lives in `src/history/`.

**5. Idempotency store.** LRU with TTL, default 10k entries and 24h. Implements the `IdempotencyStore` interface so customers can swap in Redis. Lives in `src/idempotency/`.

**6. PaymentIntent state machine.** Each payment is a `PaymentIntent` that transitions through `pending` -> `pending_approval` -> `approved` -> `completed` (with branches for `denied`, `failed`, `timed_out`). Status changes fire callbacks registered via `intent.onStatusChange(cb)`. Lives in `src/intent.ts`.

The audit log is a side-channel that records every state transition. Default sink is JSON lines to stdout. Customer overrides via the `audit` option on the factory.

## Approval channels

v1 ships two approval channels and no HTTP webhook subsystem:

- `console` is a CLI prompt that blocks the agent process. Dev and demo only.
- `callback` invokes the customer's `onApprovalNeeded` async function in-process. The customer's function does whatever (Slack, email, dedicated UI, internal queue) and returns the decision. Library is dumb on purpose; approval routing is the customer's job.

Webhook delivery (library POSTs out to a URL) is deferred to v1.5.

## Things to NOT do

These were considered and explicitly rejected during design. Reverse only with a written argument that supersedes the design doc.

- Do not add an HTTP webhook server for status delivery in v1. In-process callbacks only. This is decision OV3 in the design doc.
- Do not add a Stripe Issuing card auth-webhook handler. Different architectural shape, deferred. The library is push-style only in v1.
- Do not invent new policy operators ad-hoc. The schema lives in `schemas/policy.schema.json` and the cookbook documents every operator. Adding an operator means updating both, plus a new test case.
- Do not let stateful operators query the audit log directly. They go through the `HistoryStore` interface. The audit log can be shipped off-machine (Datadog, S3) and is not always queryable.
- Do not auto-sort policy rules. The library lints (warns) on suspicious orderings but never rewrites the customer's file.
- Do not enable regex in `intent_contains_*` operators. ReDoS risk. Substring only in v1.
- Do not bundle a Slack or email integration into the core package. Optional `@nmrtn/blacktea-slack` and similar can ship as separate packages in v1.5.

## Implementation order (lane A first)

The 12 tasks have explicit dependencies. The right order to write code is:

1. Project scaffolding (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, ESLint or Biome).
2. T2: `schemas/policy.schema.json` and derived Zod types. Validate the 10 cookbook examples as the first green test.
3. T3: `PolicyEvaluator` interface and the JSON+Zod default implementation. Unit-test every operator and combinator.
4. T4: `IdempotencyStore` interface and LRU+TTL default backed by `lru-cache`.
5. T1: the `blacktea()` factory that wires them together.
6. T5: x402 rail adapter using `x402-axios` or `@coinbase/x402`.
7. T7: mock facilitator for tests.
8. T8: `PaymentIntent` and `onStatusChange`.
9. T9: Claude Agent SDK demo.

Lane D (T10 CI, T11 README polish, T12 typed errors) can run in parallel at any time.

T6 (Stripe rail) was on the original list and is now deferred to v1.5+ alongside the Stripe Issuing card auth handler. Do not implement it in v1.

## Project naming

The npm package is `@nmrtn/blacktea`. The bare `blacktea` name is squatted on npm by an unrelated placeholder package from 2017. Do not waste time chasing it without a clear path to a transfer.

The exported factory is `blacktea(opts)`. The default exported entry point in the demo is the same name.
