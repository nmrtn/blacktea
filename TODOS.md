# TODOS

Tracked follow-ups. Each item names the finding it came from, the concrete
developer pain, and enough context to pick it up cold.

## Open

(none from the 2026-05-29 security review)

## Publishing discipline

### ⚠ ApprovalRecord schema merged but unpublished — DO NOT `npm publish` until implementation lands

PR #6 merged on `main` adds `src/approval-record.ts` and exports
`ApprovalRecord` / `ApprovalRoute` / `ApprovalFinalState` from
`src/index.ts`. These types are a **design preview**: the contract is
public on `main` but no code emits an `ApprovalRecord` yet.

If you `npm publish` from `main` as-is, those types ship to npm without
the working feature behind them. The right cadence is:

1. Implement emission in `agent.ts` (mint a record at `approval_staged`,
   update lifecycle state through `payment_completed` / `payment_denied` /
   `approval_timed_out`, write append-only to the audit JSONL tagged
   `event: "approval_record"`, add the JCS canonicalizer for
   `params_hash` per the schema's tagged format).
2. Add tests for emission.
3. Bump SDK to **0.1.5**.
4. CHANGELOG + publish.

Until step 3, leave the version at 0.1.4 on `main` and do not publish.
The schema lives in source as a contract for the upcoming feature.

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
