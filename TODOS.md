# TODOS

Tracked follow-ups. Each item names the finding it came from, the concrete
developer pain, and enough context to pick it up cold.

## Security / correctness (from 2026-05-29 review)

### P0-2 — Idempotency does not prevent concurrent double-spend

**What:** The idempotency cache is checked before settlement (`src/agent.ts:148`)
and written only after settlement (`src/agent.ts:269`). Two concurrent `pay()`
calls with the same `idempotency_key` both pass the empty-cache check and both
settle. The MCP approval path has the same shape: `approve_payment` deletes the
staged intent only after `pay.complete()` returns (`mcp-server/src/index.ts`),
so two concurrent approvals can both settle.

**Why it matters:** For a spending-control product, "we dedup retries" is a core
promise. Default keys are unique UUIDs (`src/agent.ts:138`), so this only bites a
caller who reuses an idempotency key concurrently — which is exactly the safe-retry
case idempotency exists for.

**Fix:** Reserve the key before `rail.settle` (write a pending marker, or keep an
in-flight `Promise` map keyed by `idempotencyKey` and await the existing promise on
a second concurrent call). For MCP, delete the staged intent BEFORE awaiting
`pay.complete()` (claim-then-settle), matching the existing "consumed either way"
comment.

**Effort:** human ~half day / CC ~30min. Needs concurrency tests.

### P1-1/3 — Two-phase approvals ignore the policy approval timeout

**What:** `approval.timeout_seconds` is honored in the one-shot callback/console
path but dropped by `pay.stage()` (`src/agent.ts:334`). `StagedIntent`
(`src/types.ts:115`) carries no expiry, and MCP applies a fixed 1-hour TTL
(`mcp-server/src/index.ts:51`). A policy that says "approval expires in 60s" can
still be approved much later through MCP.

**Why it matters:** A short approval window is a security control (a held payment
shouldn't be approvable hours later). Today that control silently doesn't apply on
the MCP/chat path, which is the headline integration.

**Fix:** Add `expires_at` to `StagedIntent`, set it in `stage()` from
`decision.timeout_seconds`, check it in `complete()` (throw `ApprovalTimeoutError`
when expired), and have the MCP server use the staged expiry instead of the fixed
hour.

**Effort:** human ~half day / CC ~20min. Add expiry tests.

### P1-5 — "audit" surfaces only completed payments, not every state transition

**What:** The architecture says the audit log records every state transition, but
`history.record()` only fires on completion (`src/agent.ts:259`). CLI `audit show`
and MCP `audit_query` read the history file (`src/cli.ts:137`,
`mcp-server/src/index.ts:343`), so denials, approval requests, timeouts, failed
settlements, and policy evaluations are invisible there. CLI/MCP also silence the
audit sink (`mcp-server/src/index.ts:98`).

**Why it matters:** For a spending-control product, "show me what my agent tried to
spend" should include the things you blocked. Calling the completed-payments log
"audit" is surprising and undersells the product.

**Fix (pick one):**
- Naming/docs: rename the CLI/MCP command to `payments`/`history` and stop calling
  the history file "the audit log" in README/CLAUDE.md. Fast.
- Real feature: have the default CLI/MCP audit sink persist every event to an
  `audit.jsonl`, and have `audit show`/`audit_query` read THAT (history.jsonl stays
  for cap math). More work, but it makes the documented behavior true.

**Effort:** naming/docs human ~1h / CC ~15min; real audit sink human ~1 day / CC ~45min.
