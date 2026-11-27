# Approval receipts with a trigger field

Date: 2026-11-27
Status: draft, awaiting approval
Target versions: `@nmrtn/blacktea` 0.1.5, `@nmrtn/blacktea-mcp` 0.1.4

## Intent and why

When a payment is held for a human, blacktea should leave behind a receipt
that answers four questions later: what exactly was approved, why the agent
asked, who decided what, and what happened to the money. Today the type
`ApprovalRecord` exists in `src/approval-record.ts` (PR #6) but nothing
creates one.

Two reasons to do it now:

1. `TODOS.md` blocks `npm publish` until the type has working code behind it.
2. The Versine Launch HN thread (item 50634426, 2026-11-24) asked for exactly
   this from agent payment tools: an approval tied to the exact amount and
   payee so a "yes" cannot be reused, and an approval prompt that says what
   made the agent ask ("Pay Sam $40 because of the message from Sam at 3pm").

It is also the groundwork for a future bank-transfer rail (SEPA), where
payments are final and the approval record is the only trail.

## Goals

- Every payment that reaches a human produces a receipt, on all three paths:
  `pay()` with the `console` channel, `pay()` with the `callback` channel,
  and `pay.stage()` / `pay.complete()` (the MCP path).
- The receipt survives on the CLI and MCP paths, which silence the audit sink.
- An approval is bound to the exact request the human saw. If the staged
  request changes before `complete()`, settlement is refused.
- An approval is single-use at the SDK level. Replaying `complete(staged,
  "approve")` after it has resolved is refused.
- The agent can say what triggered the request, and the human sees it before
  deciding.

## Non-goals

- Signing receipts. Deferred until the shape is stable (as the schema file says).
- A new policy operator. `trigger` is not matchable by policy rules.
- Persisting the whole audit stream to a file. Still deferred (see TODOS P1-5).
- An MCP tool to read receipts. The CLI command below is the only reader.
- Multi-user `actor`. Stays `null`.
- Any change to the history store or the idempotency store, or to the
  `RailAdapter` interface. (The x402 rail's `settle()` does change; see
  section 5.)
- Publishing to npm. The user does that.

## Anti-goals

- Treating `trigger` as proof. It is the agent's own claim; a prompt-injected
  agent can lie. Docs and tool descriptions must say "reported by the agent".
- Storing request bodies or headers in a receipt. They are hashed (body) or
  ignored (headers), never written. Never the private key.
- A receipt write failure that loses a completed payment, or that lets a
  payment settle with no receipt of the approval.

## Constraints

- CLAUDE.md "Things to NOT do" all hold: no webhook server, no ad-hoc policy
  operators, stateful operators never read these files, no regex, no secrets
  in logs.
- CLI and MCP own stdout. Nothing new may print there.
- No new runtime dependency. The canonical JSON step is small enough to write
  in-house.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` pass in
  both packages.

## Approaches

Three ways to act on the Versine comparison were considered:

1. **A European Versine** (consumer app, identity checks, licensed partners).
   Rejected: a funding and distribution game, not a spare-time project.
2. **A SEPA rail for blacktea.** Kept for later. It needs receipts first,
   because bank transfers are final.
3. **Finish approval receipts.** Chosen by the user. Smallest step, asked for
   in the thread, required by option 2.

Within option 3, two scopes were offered for the "why" part:

- **Minimal:** copy the existing `intent` text onto the receipt.
- **With trigger:** also add an optional `trigger` input to `pay()` across
  SDK, CLI and MCP. Chosen by the user.

## Design

### 1. The `trigger` input (user's decision)

`PayInput` gains `trigger?: string`: a short free-text statement of what
prompted this payment, for example `"message from Sam at 15:02 asking for
his half of dinner"`.

- Validation: when present it must be a string of 1 to 500 characters,
  otherwise `ValidationError`.
- Surfaces: SDK field, CLI `--trigger <text>` on `blacktea pay`, MCP `pay`
  argument `trigger`. The MCP tool description tells the agent to fill it
  with the message, file or event that led to the request.
- Shown to the human: console prompt (a `trigger:` line), `ApprovalRequest`
  (`trigger?: string`), `StagedIntent` (`trigger?: string`), and the MCP
  `approval_required` response (its own field, and in the `message` text as
  "Reported trigger: ...").
- Recorded: on the receipt and in the `intent_created` audit event.
- Not passed to the policy evaluator. `PaymentIntentInput` is unchanged.
- Not part of the hash. It does not change what is settled.

Display safety (my call): wherever `intent` and `trigger` are printed for a
human (console prompt, MCP message), control characters and line breaks are
replaced by a space, so agent-supplied text cannot fake extra prompt lines.
Stored values are kept as given.

### 2. The receipt shape (my calls, changes to the PR #6 type)

The type is on `main` but unpublished, so it can still change freely.

```ts
export type ApprovalState =
  | "staged" | "approved" | "denied" | "expired" | "settled" | "failed";

export interface ApprovalRecord {
  intent_id: string;
  created_at: string;          // when the receipt was first minted
  updated_at: string;          // when this snapshot was written
  state: ApprovalState;
  channel: "console" | "callback" | "staged";
  mcp_server: string | null;
  tool: string | null;
  actor: string | null;        // always null in this version
  amount: number;
  currency: string;
  recipient_wallet?: string;
  recipient_url: string;
  intent: string;              // the agent's stated purpose
  trigger: string | null;      // what the agent says prompted it
  rule_fired: string;
  decision_reason: string | null; // why the human denied, when they said
  params_hash: string;
  expires_at: string;
}
```

Changes from the PR #6 draft, each my call:

- Added `intent`, `trigger`, `updated_at`.
- `final_state` renamed `state` (it is not final while `staged`); the
  `ApprovalFinalState` export is renamed `ApprovalState`.
- `route` replaced by `channel`. A receipt only exists when a human is in the
  loop, so `route` could only ever be `human_review`. `channel` says how the
  human was reached. `ApprovalRoute` export removed.
- `reason` replaced by `decision_reason`. Why approval was needed is already
  `rule_fired`. What is worth keeping is why the human said no: the callback
  channel's `ApprovalDecision.reason`, or `console_denied` on the console.
  It is `null` on approve, on timeout, and on the two-phase path (where
  `complete()` takes no reason).
- `audit_event_refs` removed. Audit events have no ids; `intent_id` already
  joins a receipt to its events.

### 3. Lifecycle

A receipt is a series of full snapshots, one per state change. The latest
snapshot for an `intent_id` is the current receipt.

| Path | Minted (`staged`) at | Then |
|---|---|---|
| `pay()` console / callback | just before the human is asked | `approved` or `denied` or `expired`; after `approved`: `settled` or `failed` |
| `stage()` | when `approval_required` is returned | by `complete()`: `approved` then `settled` / `failed`; `denied`; `expired` if approve arrives late |

Notes:

- A staged payment nobody ever completes stays `staged` on disk. Readers
  treat `staged` with `expires_at` in the past as expired. The CLI shows it
  as `expired (unresolved)`.
- A late reject after expiry writes `denied`, matching today's behavior.
- Policy rejects and auto-approved payments produce no receipt.
- Dry-run: receipts are written, to the dry-run file (below); a simulated
  settle ends in `settled`.

### 4. Binding approval to the request

`params_hash` is computed once, when the receipt is minted, in the format
the schema file already defines:

```
"sha256:jcs-v1:" + hex(sha256(JCS({
  method: (input.method ?? "GET").toUpperCase(),
  url, amount, currency,
  recipient_wallet: recipient_wallet ?? null,
  body: input.body ?? null
})))
```

`amount`, `currency`, `recipient_wallet` come from the rail's
`PaymentRequirement`. JCS (RFC 8785) is implemented in a small in-house
function: object keys sorted, no whitespace, `JSON.stringify` for strings
and numbers.

Enforcement on the two-phase path:

- The factory keeps a private map `intent_id -> params_hash` for payments it
  has staged. It is not reachable from the `StagedIntent` object.
- `complete(staged, "approve")` recomputes the hash from `staged._input` and
  `staged._requirement` and compares it with the map entry. On mismatch it
  writes a `failed` snapshot, emits `approval_mismatch`, and throws without
  calling the rail.
- Single use: once a `complete()` call has resolved (settled, failed, denied,
  expired or mismatch), the map entry is removed. A later `complete()` for
  the same `intent_id`, or for a staged intent this factory never issued,
  throws without calling the rail.
- Concurrent duplicate `complete(approve)` calls keep today's behavior: they
  share one settlement and resolve to the same `PaymentIntent`.

New error class `ApprovalInvalidError` (code `approval_invalid`) with a
`reason` of `"params_changed"` or `"unknown_or_consumed"`, exported from the
barrel and recognized by `isBlackteaError`. The MCP server needs no special
handling; its existing `isBlackteaError` branch surfaces it.

What this protects against, stated plainly: the held payment being altered
in memory between the human's look and the settle (a bug, or code holding
the `StagedIntent`), and an approval being replayed. The server changing its
quote between preflight and settle is covered by section 5. It does not
protect against the agent lying to the human about what the payment is for.

### 5. The x402 rail pays only what was approved (user's decision)

Found by the design review. Today `settle()` in `src/rails/x402.ts` ignores
the `requirement` it is given: it calls `wrapFetchWithPayment(fetch, signer)`
and signs whatever the server's second 402 response asks for. A server can
quote one amount or payee at preflight and another at settle, and the
receipt would still show the approved values. This affects every x402
payment, auto-approved ones included, not only held ones.

A second defect in the same call: `x402-fetch` 1.2.0 defaults its `maxValue`
cap to 0.10 USDC when none is passed, so any payment above 0.10 USDC fails
at settle today, whatever the policy says.

The fix, inside `x402Wallet.settle()` only:

- Pass `maxValue`: the approved amount in base units, taken from the
  preflight quote's raw `maxAmountRequired` as a `bigint` (no float
  round-trip).
- Pass a `paymentRequirementsSelector` that accepts a settle-time
  requirement only if its `payTo` (compared case-insensitively), `network`
  and `asset` equal the preflight quote's and its `maxAmountRequired` is not
  above the approved amount. If none qualifies, it throws and nothing is
  signed.
- A lower settle-time price to the same payee is allowed. The receipt must
  then carry what was actually signed, so `Receipt.amount` and
  `recipient_wallet` come from the requirement the selector accepted, not
  from the preflight quote.
- A refusal surfaces as a new `QuoteChangedError` (code `quote_changed`),
  not the generic `RailUnavailableError`, so callers and the receipt can
  tell it apart. `agent.ts` rethrows it unchanged; the receipt goes to
  `failed`; the audit event is `payment_failed` with `error: "quote_changed"`.

The `RailAdapter` interface does not change. Its doc comment gains one
sentence: `settle()` must not pay more than `requirement.amount` or to a
different recipient than `requirement.recipient_wallet`. The mock rail
already satisfies this.

### 6. Storage

New interface and default, mirroring the history store:

```ts
export interface ApprovalStore {
  append(record: ApprovalRecord): Promise<void>;
}
```

- `FileBackedApprovalStore({ path })`: append-only JSONL, one snapshot per
  line, default `./.blacktea/approvals.jsonl`
  (`./.blacktea/approvals-dryrun.jsonl` under `dry_run`). Creates the
  directory if missing. Lives in `src/approvals/file-backed.ts`.
- `BlackteaOptions` gains `approvals?: ApprovalStore`.
- Every snapshot is also emitted through the audit sink as event
  `approval_record` with the record as `data`.
- MCP server: new env `BLACKTEA_APPROVALS`, default `approvals.jsonl` in the
  same directory as the resolved history path (not the process cwd, for the
  reason the history-path comment in `mcp-server/src/index.ts` gives). Listed
  in the startup banner on stderr.
- MCP server passes provenance through a new `PayOptions.origin?: {
  mcp_server: string; tool: string }`, which fills `mcp_server` and `tool`.
  SDK and CLI callers leave both `null`.

Write failures:

- Writing the `staged` or `approved` snapshot fails: throw before any
  settlement (fail closed).
- Writing a snapshot after the rail has settled fails: do not throw. Emit an
  `approval_record_write_failed` audit event and return the completed intent.

### 7. Reading receipts

New CLI command `blacktea approvals show`:

- `-n, --last <n>` (default 20), `--json`, `--store <path>` (default
  `./.blacktea/approvals.jsonl`).
- Collapses snapshots to the latest per `intent_id`, newest first.
- Table columns: time, state, amount, recipient, trigger (truncated).
  `--json` prints one full record per line.

### 8. Docs and housekeeping

- README: a short "Approval receipts" section and the `trigger` field in the
  SDK, CLI and MCP examples. `mcp-server/README.md`: `trigger` and
  `BLACKTEA_APPROVALS`.
- CLAUDE.md: add the approval store to the architecture list and repo layout.
- README and CHANGELOG state the x402 fix as a security fix: before 0.1.5 a
  server could change its quote between preflight and settle.
- CHANGELOG entries for both packages; versions bumped to 0.1.5 and 0.1.4
  (including the `VERSION` constants).
- TODOS.md: move the publishing-discipline item to done.
- `docs/policy-cookbook.md`: one line stating `trigger` is not matchable.

## Tests

In `test/agent.test.ts` (or a new `test/approval-record.test.ts`), with the
mock rail and an in-memory `ApprovalStore`:

- Receipt sequence for each path: console approve, callback approve, callback
  deny, callback timeout, stage then approve, stage then reject, stage then
  late approve.
- No receipt for auto-approved and policy-rejected payments.
- `trigger` and `intent` land on the receipt; `trigger` is `null` when absent;
  invalid `trigger` throws `ValidationError`.
- Hash is stable for the same request and differs when amount, url, method,
  body or recipient changes; key order in `body` does not change it.
- Mutating `staged._requirement.amount` (and `_input.url`) before
  `complete(approve)` throws `ApprovalInvalidError` and never calls the rail.
- Second sequential `complete(approve)` throws and never calls the rail;
  concurrent duplicates still share one settlement.
- Store failure at `staged` blocks the payment; store failure after settle
  still returns the completed intent.
- The receipt and audit events never contain the body, headers or key.

`test/rails/x402.test.ts`, against the existing mock facilitator: settle
succeeds when the second quote matches; succeeds and records the lower amount
when the second quote is cheaper; throws `QuoteChangedError` and signs
nothing when the second quote is higher, names a different `payTo`, or
changes network or asset; a payment above 0.10 USDC settles.

`test/approvals/file-backed.test.ts`: append, directory creation, reload.
`test/cli.test.ts`: `--trigger` passthrough and `approvals show` (table and
`--json`, latest-per-intent collapse). `mcp-server/test`: `trigger` appears
in the `approval_required` response; a receipt file is written at the
`BLACKTEA_APPROVALS` path; approve after approve returns an error.

## Left to the builder

- Internal structure in `agent.ts` (a small helper that mints and advances
  receipts is expected).
- How non-JSON `body` values are canonicalized before hashing.
- Exact wording of prompts, tool descriptions and table layout.
- Whether `ApprovalInvalidError` gets its own CLI exit code (the CLI does not
  call `complete()` today). `QuoteChangedError` does get one, since
  `blacktea pay` can hit it.
- The exact shape of the `x402-fetch` selector callback; check its types in
  `node_modules/x402-fetch` rather than assuming.
