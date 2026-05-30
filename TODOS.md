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

---

## Done in v0.1.3 (2026-05-29)

### ✅ P1-1/3 — Two-phase approvals honor the policy approval timeout

Shipped in v0.1.3. `StagedIntent` carries `expires_at` (computed from
`decision.timeout_seconds`); `pay.complete(staged, "approve")` throws
`ApprovalTimeoutError` past expiry; late reject still works. MCP cleanup of its
fixed-1h TTL lands with `@nmrtn/blacktea-mcp` 0.1.2.

### ✅ P1-5 — "audit" terminology clarified

Shipped in v0.1.3. CLI `audit` and MCP `audit_query` descriptions rewritten to
say "the history of completed payments" with an explicit note that held / denied
/ expired payments live in the audit sink, not in the history file. The bigger
"persist every event to a real audit.jsonl" refactor stays deferred until a
user asks; the naming was the load-bearing part.
