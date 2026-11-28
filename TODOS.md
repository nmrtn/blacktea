# TODOS

Tracked follow-ups. Each item names the finding it came from, the concrete
developer pain, and enough context to pick it up cold.

## Open

### x402: a signed payment that errors after send is recorded as failed and not counted in history

From the 2026-11-27 final review of `feat/approval-receipts`. If the server
takes the signed payment header and then answers non-2xx, or the
connection drops, `settle()` throws, the receipt ends `failed`, nothing is
recorded in history, and the signed authorization stays redeemable until
it expires. Spend limits then undercount money that may have moved.
Code: `src/rails/x402.ts` (the `settle` catch and the non-OK branch),
`src/agent.ts` (`doSettleAndRecord`). Direction: once the selector has
accepted a quote, throw a distinct error that says the payment may have
been paid, and record it to history conservatively.

### Spending limits do not hold across processes sharing a history file

Narrowed from "Spending limits do not hold across payments made at the same
time" (security review of the landing page, 2026-11-28). Inside one
`blacktea()` factory the limit now holds: a payment the policy lets through
counts toward `would_spend` and `amount_today_gte` while it settles or
waits for approval (`pendingSpends` in `src/agent.ts`). Two processes
pointing at the same `history.jsonl` (two CLI invocations run in parallel,
several agents sharing a directory) still each read history before the
other has recorded, and the file-backed store has no locking. Direction: a
`HistoryStore` backed by something with atomic reserve-then-commit (SQLite,
Redis), or a lock file around evaluate-through-record in the CLI.

## Publishing discipline

`@nmrtn/blacktea` 0.1.5 and `@nmrtn/blacktea-mcp` 0.1.4 are published.
Publishing is a manual step (`npm publish`, run by hand), SDK first.

`@nmrtn/blacktea` 0.1.6 is ready to publish once its release commit is on
`main`. The MCP server depends on `^0.1.5`, so fresh installs pick up 0.1.6
without an MCP release.

---

## Done in v0.1.5 (2026-11-27)

### ✅ ApprovalRecord emission

The `ApprovalRecord` schema that sat on `main` as an unpublished design
preview is now backed by the feature. `agent.ts` mints a receipt when a
payment is held, advances it through approved, denied, expired, settled and
failed, appends it to `./.blacktea/approvals.jsonl`, and mirrors each
snapshot to the audit sink as `approval_record`. Also shipped: the `trigger`
input, single-use approvals bound to the staged request, the x402 settle-time
quote check, and `blacktea approvals show`.

---

## Done in v0.1.4 (2026-05-30)

### ✅ P0-2 — Concurrent settlements no longer over-spend

Shipped in v0.1.4 + mcp 0.1.3. The idempotency cache check + write was a
TOCTOU race: two concurrent `pay()` calls with the same key both saw an
empty cache and both settled. Fixed via an in-flight Promise map keyed by
`idempotencyKey` inside `settleAndRecord`: the first caller's Promise is
registered; concurrent callers await it and resolve to the same
PaymentIntent. The MCP server pairs the SDK guard with claim-then-await:
`stagedIntents.delete(intentId)` runs synchronously before the
`pay.complete` await, so a second concurrent `approve_payment` lands its
get() after the delete and sees `not_found`. Tests cover shared-key
pay(), shared-key complete(approve), and a sanity check that
different-key calls still run independently.

---

## Done in v0.1.3 (2026-05-29)

### ✅ P1-1/3 — Two-phase approvals honor the policy approval timeout

Shipped in v0.1.3. `StagedIntent` carries `expires_at` (computed from
`decision.timeout_seconds`); `pay.complete(staged, "approve")` throws
`ApprovalTimeoutError` past expiry; late reject still works. MCP cleanup of
its fixed-1h TTL lands with `@nmrtn/blacktea-mcp` 0.1.2.

### ✅ P1-5 — "audit" terminology clarified

Shipped in v0.1.3. CLI `audit` and MCP `audit_query` descriptions rewritten
to say "the history of completed payments" with an explicit note that held
/ denied / expired payments live in the audit sink, not in the history
file. The bigger "persist every event to a real audit.jsonl" refactor stays
deferred until a user asks; the naming was the load-bearing part.
