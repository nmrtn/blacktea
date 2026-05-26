# Changelog

All notable changes to this repo's packages. Format roughly follows Keep a
Changelog. SemVer applies to each package independently.

This file covers both `@nmrtn/blacktea` (the SDK + CLI) and `@nmrtn/blacktea-mcp`
(the MCP server). Each release section names the package and version.

---

## `@nmrtn/blacktea` v0.0.3 — 2026-05-26

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
  programmatic API was never affected — only the CLI surface.

### Internal

- `.gstack/` added to `.gitignore` so security audit reports never accidentally
  commit.

## `@nmrtn/blacktea-mcp` v0.0.2 — 2026-05-26

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

## `@nmrtn/blacktea` v0.0.2 — 2026-05-26

Initial CLI release. Adds the `blacktea` shell binary alongside the SDK.

- `blacktea pay`, `blacktea audit show`, `blacktea policy validate`,
  `blacktea policy test`.
- Exit codes: 1=generic, 2=config, 3=policy denied, 4=approval timeout,
  5=no eligible rail, 6=rail unavailable, 7=validation, 8=policy parse.
- JSON output by default so agents can parse it.

## `@nmrtn/blacktea-mcp` v0.0.1 — 2026-05-26

Initial MCP release. Stdio JSON-RPC server exposing `pay` and `audit_query`
to Claude Desktop, Cursor, and any MCP-aware client.

**Known issue (fixed in v0.0.2):** the published manifest references
`@nmrtn/blacktea` via `file:..`, which doesn't resolve at install time.
Upgrade to `@nmrtn/blacktea-mcp@0.0.2`.

## `@nmrtn/blacktea` v0.0.1 — 2026-05-26

First publish. SDK only — `blacktea()` factory, x402 rail adapter, JSON
policy DSL with 10 operators + 3 combinators, file-backed history store,
in-memory LRU idempotency, typed errors.
