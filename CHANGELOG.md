# Changelog

All notable changes to this repo's packages. Format roughly follows Keep a
Changelog. SemVer applies to each package independently.

This file covers both `@nmrtn/blacktea` (the SDK + CLI) and `@nmrtn/blacktea-mcp`
(the MCP server). Each release section names the package and version.

---

## Unreleased

Pre-launch correctness fixes from the 2026-05-29 review. Version bump + publish
pending.

### `@nmrtn/blacktea` (SDK + CLI)

- **Fixed: `wallet_in` file paths now work.** The loader resolves a
  file-path-form `wallet_in` (e.g. `"./blocklist.txt"`) into an inline array
  at load time: one wallet per line, `#` comments and blank lines ignored,
  resolved relative to the policy file's directory. The documented
  sanctions/blocklist policy in the README and cookbook now runs instead of
  throwing at evaluation time.
- **Fixed: x402 non-JSON responses no longer lose data.** When a paid endpoint
  returns plain text, `settle` now returns the raw text instead of silently
  dropping it to `undefined`. An empty body still resolves to `undefined`.
- **Changed: policy/config errors now link to the cookbook.** `PolicyParseError`
  and the CLI "policy file not found" message point at
  `docs/policy-cookbook.md` so a stuck developer has a next step.

### `@nmrtn/blacktea-mcp` (MCP server)

- **Fixed: mock mode runs with no wallet.** `BLACKTEA_RAIL=mock` no longer
  requires `EVM_PRIVATE_KEY`. The rail is detected before the key check, so the
  no-wallet demo path advertised in the README actually works.

### Docs

- Corrected the cookbook's false "file locking" claim: the default
  `FileBackedHistoryStore` does NOT lock, and concurrent writers can corrupt the
  history file. Give each agent its own history path.

---

## `@nmrtn/blacktea` v0.1.1 - 2026-05-28

Performance: faster startup, lighter footprint. No API changes.

### Changed

- x402-fetch is now loaded lazily (a dynamic import on the first `settle`)
  instead of at module load. x402-fetch pulls in a large dependency tree
  (viem, metamask/walletconnect); deferring it makes importing the library,
  importing the adapters, constructing a wallet, preflighting, and running the
  policy near-instant. The adapters barrel import dropped from hundreds of ms
  (loading the whole wallet stack) to about 7 ms. Mock-rail usage never loads
  x402-fetch at all. This helps MCP hosts that spawn the server and expect a
  quick handshake. Note: this speeds module LOAD time, not the first-run npm
  download of x402-fetch's dependencies (that is inherent to the dependency).

The `@nmrtn/blacktea-mcp` server does not need a new release: it depends on
`@nmrtn/blacktea` `^0.1.0`, so `npx -y @nmrtn/blacktea-mcp` resolves the fixed
SDK automatically.

## `@nmrtn/blacktea` v0.1.0 - 2026-05-28

First minor release. Adds the two-phase payment API that makes
out-of-process human approval possible: the missing piece for chat
agents (Hermes, OpenClaw, Claude Desktop) where the human is reachable
only through the agent, not through a blocking in-process callback.

### Added

- **`pay.stage(input)` and `pay.complete(staged, decision)`.** The
  callable `pay()` you already use is unchanged; these are additive
  methods on it. `stage()` runs preflight + policy and returns one of
  `{ outcome: "completed" }` (auto-approved, already settled),
  `{ outcome: "rejected" }` (policy said no), or
  `{ outcome: "approval_required", staged }` (held, NOT settled).
  `complete(staged, "approve" | "reject")` settles or denies a held
  payment once a human has decided out of band. Money never moves on
  an `approval_required` payment until `complete(…, "approve")` is called.
- New exported types `StagedIntent` and `StageResult`.

### Unchanged

- `pay()` one-shot behavior is identical. Existing SDK code needs no
  changes. The in-process approval channels (`console`, `callback`)
  still work exactly as before.

## `@nmrtn/blacktea-mcp` v0.1.0 - 2026-05-28

In-conversation approval. The headline feature for personal-agent use.

### Added

- **`approve_payment` and `reject_payment` tools.** When the policy says
  a payment needs approval, the `pay` tool no longer fails: it returns
  `status: "approval_required"` with an `intent_id` and the amount, and
  holds the payment in memory. The agent relays the amount to the human;
  on a yes, the agent calls `approve_payment` with the `intent_id` and
  the payment settles. On a no, `reject_payment`. This is the
  ask-before-spending flow that was impossible through MCP before
  (console approval corrupts the stdio stream; callback approval has no
  human to call). Held intents expire after 1 hour.
- **`BLACKTEA_RAIL=mock` mode.** Run the server against a no-network
  simulated rail to exercise the policy + approval + audit flow with no
  x402 endpoint, no wallet, and no USDC. `BLACKTEA_MOCK_AMOUNT` sets the
  price the mock "charges" so you can drive auto-approve vs.
  approval-required vs. reject deterministically. Great for trying the
  server or for demos.

### Changed

- Dependency on `@nmrtn/blacktea` bumped to `^0.1.0` (needs the new
  `pay.stage`/`pay.complete` API).
- Startup banner now reports the active rail: `… ready. rail=mock …`.

## `@nmrtn/blacktea` v0.0.4 - 2026-05-27

Adds `mockWallet`, a no-network rail adapter. The reason this exists:
trying the library used to require a Coinbase Developer Platform
account, a Base Sepolia wallet, ETH for gas, USDC from a faucet, and
a running x402 endpoint. That's fine for production but brutal for
"let me see if this is real."

### Added

- `mockWallet({ amount, currency, ... })` exported from
  `@nmrtn/blacktea/adapters`. A `RailAdapter` that does no network and
  no signing. `preflight` returns a configurable `PaymentRequirement`,
  `settle` returns a synthetic `Receipt` marked `simulated: true`. The
  policy engine still fires, the approval callback still runs, the
  audit log still writes. Everything except the actual signing.
  Useful for local dev, demos, CI, and reading the policy you just
  wrote without committing to spending money.

### Fixed

- `VERSION` exported from `@nmrtn/blacktea` was stale at `"0.0.1"` since
  the initial release. Now matches `package.json`.

## `@nmrtn/blacktea-mcp` v0.0.3 - 2026-05-27

### Fixed

- The MCP server now passes a `FileBackedHistoryStore` constructed at
  the resolved `BLACKTEA_HISTORY` path to the `blacktea()` factory.
  Previously, `audit_query` read from the env-resolved path while
  `pay()` wrote to the SDK's default `./.blacktea/history.jsonl`
  (resolved against whatever `cwd` the MCP client spawned the server
  in, usually `/` or `$HOME`, never predictable). The two diverged
  silently and `audit_query` returned stale or empty data. Now one
  path, one store, both consumers use the same file.

### Changed

- Startup banner now reports the resolved history path:
  `… ready. chain=base-sepolia policy=… history=…`. Helps when
  debugging MCP integrations to confirm the env vars actually
  threaded through.
- Dependency on `@nmrtn/blacktea` bumped to `^0.0.4`.

---

## `@nmrtn/blacktea` v0.0.3 - 2026-05-26

Security patch. Run a `/cso` self-audit, found a fail-open on the CLI, fixed it.

### Security

- **CLI `--max-amount` no longer silently drops the safety cap on bad input.**
  Previous behavior: `Number.parseFloat` was used to parse the flag, and the
  result fed a truthy check before being forwarded to `pay()`. `NaN`, `0`, `-0`,
  and suffix-typed garbage like `"1usd"` all evaluated falsy, so the call
  proceeded with NO cap. The library's own `Number.isFinite` validator never
  fired because the `max_amount` key had already been stripped.

  New behavior: `Number()` (strict whole-string parse) plus `Number.isFinite`
  plus positivity check at parse time. Bad input exits 7 with
  `code: "invalid_input"` before any rail or policy work runs. Call site
  uses explicit-undefined check. Six regression tests added.

  This was a HIGH-severity finding in the day-one self-audit. The SDK's
  programmatic API was never affected, only the CLI surface.

### Internal

- `.gstack/` added to `.gitignore` so security audit reports never accidentally
  commit.

## `@nmrtn/blacktea-mcp` v0.0.2 - 2026-05-26

Security patch + install fix.

### Security

- **MCP server's `max_amount` argument now rejects malformed values up front.**
  Same fail-open class as the CLI fix in `@nmrtn/blacktea@0.0.3`. The server
  now rejects `null`, non-number, `NaN`, `±Infinity`, `0`, and negative values
  with `isError: true` and `code: "invalid_input"` before `pay()` runs.

### Fixed

- **MCP package was un-installable as published in v0.0.1.** The published
  manifest carried `"@nmrtn/blacktea": "file:.."` (the local-dev link) instead
  of a semver range. Consumers running `npx -y @nmrtn/blacktea-mcp` hit a
  dependency-resolution error. Dependency is now `"@nmrtn/blacktea": "^0.0.3"`.
  This is the actual install path the README documents.

### Internal

- Test fixture (`mcp-server/test/mcp-server.test.ts`) generates an ephemeral
  `randomBytes(32)` key at test start instead of a hardcoded one. Belt-and-
  suspenders after the day-one history scrub.

---

## `@nmrtn/blacktea` v0.0.2 - 2026-05-26

Initial CLI release. Adds the `blacktea` shell binary alongside the SDK.

- `blacktea pay`, `blacktea audit show`, `blacktea policy validate`,
  `blacktea policy test`.
- Exit codes: 1=generic, 2=config, 3=policy denied, 4=approval timeout,
  5=no eligible rail, 6=rail unavailable, 7=validation, 8=policy parse.
- JSON output by default so agents can parse it.

## `@nmrtn/blacktea-mcp` v0.0.1 - 2026-05-26

Initial MCP release. Stdio JSON-RPC server exposing `pay` and `audit_query`
to Claude Desktop, Cursor, and any MCP-aware client.

**Known issue (fixed in v0.0.2):** the published manifest references
`@nmrtn/blacktea` via `file:..`, which doesn't resolve at install time.
Upgrade to `@nmrtn/blacktea-mcp@0.0.2`.

## `@nmrtn/blacktea` v0.0.1 - 2026-05-26

First publish. SDK only: `blacktea()` factory, x402 rail adapter, JSON
policy DSL with 10 operators + 3 combinators, file-backed history store,
in-memory LRU idempotency, typed errors.
