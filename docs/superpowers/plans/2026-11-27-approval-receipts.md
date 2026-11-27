# Approval Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every payment held for a human leaves a durable receipt bound to the exact request, the agent can state what triggered it, and the x402 rail refuses to pay anything other than what was approved.

**Architecture:** A small `src/approvals/` module holds the request hash and a JSONL store. `src/agent.ts` mints a receipt when a human is asked and appends a full snapshot at each state change, to the store and the audit sink. `pay.complete()` checks the hash against a factory-private map and consumes it. The x402 rail passes a cap and a selector to `x402-fetch` so the settle-time quote must match the approved one.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `crypto` and `fs`, Vitest, Biome, commander (CLI), `@modelcontextprotocol/sdk`, `x402-fetch` 1.2.0.

**Spec:** `docs/superpowers/specs/2026-11-27-approval-receipts-design.md`. Read it before starting any task.

## Global Constraints

- Tasks 1 to 6 and 8 go on branch `feat/approval-receipts` cut from `main`. Task 7 (MCP server) goes on branch `feat/mcp-approval-receipts` cut from the tip of the first branch. Do not push. Do not `npm publish`.
- Release order: CI installs the MCP server's `@nmrtn/blacktea` dependency from npm, not from this checkout (locally `mcp-server/node_modules/@nmrtn/blacktea` is a symlink to the repo root, so Task 7 builds and tests here). The MCP branch can only pass CI after `@nmrtn/blacktea` 0.1.5 is published. Do not edit `.github/workflows/` to work around this.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- No new runtime dependency.
- Nothing new prints to stdout from the SDK, CLI `pay`, or the MCP server.
- Receipts and audit events never contain the request `body`, `headers`, or the private key.
- `trigger` is never passed to the policy evaluator; `PaymentIntentInput` and `src/policy/` do not change.
- Target versions: `@nmrtn/blacktea` `0.1.5`, `@nmrtn/blacktea-mcp` `0.1.4`.
- Before each commit: `npm run lint && npm run typecheck && npm test` pass at the repo root (and in `mcp-server/` for Task 7).
- Tests never write to `./.blacktea/`. Any test that reaches an approval passes an in-memory `ApprovalStore`.

## Review Focus

1. A held payment whose `body` cannot be serialized to JSON (BigInt, cycle): expect a `ValidationError` before the human is asked, not a crash mid-flow. Pinned in Task 1 and Task 4.
2. A corrupted line in `approvals.jsonl`: `blacktea approvals show` skips it and still prints the rest. Pinned in Task 6.
3. `intent` or `trigger` containing line breaks or ANSI escapes: the console prompt and the MCP message show them on one line with control characters replaced. Pinned in Task 4 and Task 7.
4. The server returns `payTo` in a different letter case at settle than at preflight: accepted as the same payee. Pinned in Task 3.
5. The settle-time 402 lists several `accepts` entries and only a later one matches the approved quote: the selector picks the matching one. Pinned in Task 3.

---

### Task 1: Request hash

**Files:**
- Create: `src/approvals/params-hash.ts`
- Test: `test/approvals/params-hash.test.ts`

**Interfaces:**
- Consumes: `PayInput`, `PaymentRequirement` from `src/types.ts`; `ValidationError` from `src/errors.ts`.
- Produces:
  - `canonicalize(value: unknown): string` (RFC 8785 for JSON values: keys sorted by UTF-16 code unit, no whitespace, `JSON.stringify` for strings and numbers).
  - `computeParamsHash(input: PayInput, requirement: PaymentRequirement): string` returning `"sha256:jcs-v1:" + <64 hex chars>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("canonicalizes with sorted keys and no whitespace", () => {
  expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } }))
    .toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
});
const input = { url: "https://a.test/x", intent: "i", method: "post", body: { q: 1, r: 2 } };
const req = { amount: 4, currency: "USDC", recipient_wallet: "0xabc" };
it("has the tagged format", () => {
  expect(computeParamsHash(input, req)).toMatch(/^sha256:jcs-v1:[0-9a-f]{64}$/);
});
it("is stable across body key order, method case, intent and headers", () => {
  const other = { ...input, method: "POST", intent: "different", headers: { a: "b" }, body: { r: 2, q: 1 } };
  expect(computeParamsHash(other, req)).toBe(computeParamsHash(input, req));
});
it.each([
  ["amount", input, { ...req, amount: 5 }],
  ["currency", input, { ...req, currency: "EUR" }],
  ["recipient", input, { ...req, recipient_wallet: "0xdef" }],
  ["url", { ...input, url: "https://a.test/y" }, req],
  ["method", { ...input, method: "GET" }, req],
  ["body", { ...input, body: { q: 1, r: 3 } }, req],
])("changes when %s changes", (_n, i, r) => {
  expect(computeParamsHash(i, r)).not.toBe(computeParamsHash(input, req));
});
it("treats missing method as GET, missing body and wallet as null", () => {
  const bare = { url: "https://a.test/x", intent: "i" };
  expect(computeParamsHash(bare, { amount: 4, currency: "USDC" }))
    .toBe(computeParamsHash({ ...bare, method: "GET", body: null }, { amount: 4, currency: "USDC" }));
});
it("rejects a body that is not JSON-serializable", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => computeParamsHash({ ...input, body: cyclic }, req)).toThrow(ValidationError);
  expect(() => computeParamsHash({ ...input, body: { n: 1n } }, req)).toThrow(ValidationError);
});
```

- [ ] **Step 2: Run** `npm test -- test/approvals/params-hash.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement both functions.** The hashed object is exactly `{ method, url, amount, currency, recipient_wallet, body }` as the spec's section 4 gives it. Normalize `body` with `JSON.parse(JSON.stringify(body))` first (so `Date`, `undefined` members and `toJSON` behave as they do on the wire); wrap a throw from that in `ValidationError("Request body is not JSON-serializable.")`.

- [ ] **Step 4: Run the test again.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(approvals): canonical request hash`.

---

### Task 2: Types, receipt shape, store, errors

**Files:**
- Modify: `src/types.ts`, `src/approval-record.ts` (rewrite), `src/errors.ts`, `src/index.ts`
- Create: `src/approvals/file-backed.ts`, `src/display.ts`
- Test: `test/approvals/file-backed.test.ts`, `test/display.test.ts`, `test/errors.test.ts` (create if absent)

**Interfaces:**
- Produces, in `src/types.ts`:
  - `PayInput.trigger?: string`
  - `ApprovalRequest.trigger?: string`, `StagedIntent.trigger?: string`
  - `PayOptions.origin?: { mcp_server: string; tool: string }`
  - `interface ApprovalStore { append(record: ApprovalRecord): Promise<void> }`
- Produces, in `src/approval-record.ts`: `ApprovalState` and `ApprovalRecord` exactly as the spec's section 2 code block (including `decision_reason: string | null`). Remove `ApprovalRoute` and `ApprovalFinalState`. Update the file header: emitted by `agent.ts`, stored in `approvals.jsonl` and mirrored to the audit sink.
- Produces, in `src/approvals/file-backed.ts`: `class FileBackedApprovalStore implements ApprovalStore`, constructor `(opts?: { path?: string })`, default path `./.blacktea/approvals.jsonl`, plus `static readLatest(path: string): ApprovalRecord[]` returning the latest snapshot per `intent_id`, newest `updated_at` first, skipping unparseable lines.
- Produces, in `src/display.ts`: `sanitizeForDisplay(text: string): string` replacing every C0/C1 control character (including `\n`, `\r`, `\t`, `\x1b`) with a single space.
- Produces, in `src/errors.ts`:
  - `class ApprovalInvalidError` with `code = "approval_invalid"`, constructor `(intent_id: string, reason: "params_changed" | "unknown_or_consumed")`, both public readonly.
  - `class QuoteChangedError` with `code = "quote_changed"`, constructor `(rail: string, detail: string)`, both public readonly.
  - Both added to `isBlackteaError`.
- `src/index.ts` exports: `ApprovalState`, `ApprovalRecord`, `ApprovalStore`, `FileBackedApprovalStore`, `sanitizeForDisplay`, `ApprovalInvalidError`, `QuoteChangedError`.

- [ ] **Step 1: Write the failing tests**

```ts
// file-backed.test.ts — use mkdtempSync(join(tmpdir(), "bt-appr-")) per test
it("does not touch the filesystem until the first append", () => {
  new FileBackedApprovalStore({ path: join(dir, "nested", "approvals.jsonl") });
  expect(existsSync(join(dir, "nested"))).toBe(false);
});
it("appends one JSON line per snapshot and creates the directory", async () => {
  const p = join(dir, "nested", "approvals.jsonl");
  const store = new FileBackedApprovalStore({ path: p });
  await store.append(rec({ intent_id: "a", state: "staged", updated_at: "2026-01-01T00:00:00Z" }));
  await store.append(rec({ intent_id: "a", state: "settled", updated_at: "2026-01-01T00:00:05Z" }));
  expect(readFileSync(p, "utf-8").trim().split("\n")).toHaveLength(2);
});
it("readLatest collapses to the latest snapshot per intent, newest first, skipping bad lines", async () => {
  // a: staged then settled; b: staged later; plus the literal line "not json"
  expect(FileBackedApprovalStore.readLatest(p).map((r) => [r.intent_id, r.state]))
    .toEqual([["b", "staged"], ["a", "settled"]]);
});
it("readLatest returns [] when the file does not exist", () => {
  expect(FileBackedApprovalStore.readLatest(join(dir, "none.jsonl"))).toEqual([]);
});
// display.test.ts
it("flattens control characters", () => {
  expect(sanitizeForDisplay("pay\nApprove? [y/N] y\r\x1b[2Kok\ttab")).toBe("pay Approve? [y/N] y  [2Kok tab");
});
// errors.test.ts
it("recognizes the new errors", () => {
  const a = new ApprovalInvalidError("intent_1", "params_changed");
  const q = new QuoteChangedError("x402", "payTo changed");
  expect([a.code, q.code]).toEqual(["approval_invalid", "quote_changed"]);
  expect(isBlackteaError(a) && isBlackteaError(q)).toBe(true);
});
```

`rec(overrides)` is a local helper returning a complete `ApprovalRecord`.

- [ ] **Step 2: Run** `npm test -- test/approvals test/display.test.ts test/errors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, record, store, display helper, errors and exports listed above. `append` uses `mkdirSync(dirname, { recursive: true })` then `appendFileSync`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (the whole suite; nothing consumed the removed type names).
- [ ] **Step 5: Commit** `feat(approvals): receipt shape, store, trigger types, errors`.

---

### Task 3: x402 rail pays only the approved quote

**Files:**
- Modify: `src/rails/x402.ts` (`settle`, file header comment), `src/types.ts` (one sentence on `RailAdapter.settle`: it must not pay more than `requirement.amount` or to a recipient other than `requirement.recipient_wallet`)
- Test: `test/rails/x402.test.ts`

**Interfaces:**
- Consumes: `QuoteChangedError` (Task 2). `x402-fetch` signature: `wrapFetchWithPayment(fetch, signer, maxValue?: bigint, selector?: (reqs: PaymentRequirements[], network?, scheme?) => PaymentRequirements, config?)`.
- Produces: no signature change. Behavior: `settle()` calls `wrapFetchWithPayment(fetch, signer, approvedBaseUnits, selector)`.

Rules for `settle()`:
- `approvedBaseUnits`: `BigInt(String(requirement.raw.maxAmountRequired))` when `requirement.raw` carries it, else `BigInt(Math.round(requirement.amount * 10 ** decimals))`.
- The selector returns the first entry whose `payTo` equals `requirement.recipient_wallet` case-insensitively, whose `network` and `asset` equal the preflight quote's (`requirement.raw`), and whose `BigInt(maxAmountRequired) <= approvedBaseUnits`. If none, it throws `QuoteChangedError("x402", <which field differed>)`. When `requirement.raw` is absent, only payee and amount are compared.
- The existing `catch` around `fetchWithPayment` rethrows a `QuoteChangedError` unchanged; everything else still becomes `RailUnavailableError`.
- The receipt's `amount` and `recipient_wallet` come from the entry the selector accepted (amount = `Number(maxAmountRequired) / 10 ** decimals`). If the selector never ran, they come from `requirement` as today.

- [ ] **Step 1: Write the failing tests.** The suite mocks `wrapFetchWithPayment`; capture its arguments and call the selector directly.

```ts
// helper: run preflight with make402Response(), then settle with a mock that
// returns a 200 + settlement header, and return mockWrapFetchWithPayment.mock.calls[0]
it("passes the approved amount as maxValue in base units", async () => {
  const [, , maxValue] = await settleAndCapture();
  expect(maxValue).toBe(10000n);
});
it("settles a payment above 0.10 USDC", async () => {
  const [, , maxValue] = await settleAndCapture({ maxAmountRequired: "4000000" });
  expect(maxValue).toBe(4000000n);
});
const approved = { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000",
  payTo: "0xRECIPIENT", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
it("selector accepts an identical quote", async () => {
  const [, , , select] = await settleAndCapture();
  expect(select([approved])).toEqual(approved);
});
it("selector accepts a payee that differs only by letter case", async () => {
  const [, , , select] = await settleAndCapture();
  expect(select([{ ...approved, payTo: "0xrecipient" }]).payTo).toBe("0xrecipient");
});
it("selector picks a later matching entry", async () => {
  const [, , , select] = await settleAndCapture();
  expect(select([{ ...approved, payTo: "0xEVIL" }, approved])).toEqual(approved);
});
it.each([
  ["higher amount", { maxAmountRequired: "10001" }],
  ["different payee", { payTo: "0xEVIL" }],
  ["different network", { network: "base" }],
  ["different asset", { asset: "0xOTHER" }],
])("selector refuses a %s", async (_n, change) => {
  const [, , , select] = await settleAndCapture();
  expect(() => select([{ ...approved, ...change }])).toThrow(QuoteChangedError);
});
it("surfaces QuoteChangedError from settle unchanged", async () => {
  // mockWrapFetchWithPayment returns a fetch that rejects with new QuoteChangedError("x402", "x")
  await expect(rail.settle(input, requirement, {})).rejects.toBeInstanceOf(QuoteChangedError);
});
it("records the lower amount when the settle-time quote is cheaper", async () => {
  // mock implementation calls the captured selector with [{ ...approved, maxAmountRequired: "5000" }] before responding 200
  expect((await rail.settle(input, requirement, {})).receipt.amount).toBe(0.005);
});
```

- [ ] **Step 2: Run** `npm test -- test/rails/x402.test.ts`. Expected: the new tests FAIL (`maxValue` undefined).
- [ ] **Step 3: Implement** per the rules above. Check the `PaymentRequirements` field names in `node_modules/x402/dist/cjs/client/index.d.ts` rather than assuming.
- [ ] **Step 4: Run** `npm test -- test/rails/x402.test.ts`. Expected: PASS, including every pre-existing test.
- [ ] **Step 5: Commit** `fix(x402): refuse a settle-time quote that differs from the approved one`.

---

### Task 4: Trigger and receipt lifecycle in the factory

**Files:**
- Modify: `src/agent.ts`
- Test: `test/approval-record.test.ts` (new), `test/agent.test.ts` (pass `approvals` wherever an existing test reaches an approval; add trigger validation cases to "input validation")

**Interfaces:**
- Consumes: Task 1 `computeParamsHash`; Task 2 types, `FileBackedApprovalStore`, `sanitizeForDisplay`, `QuoteChangedError`.
- Produces:
  - `BlackteaOptions.approvals?: ApprovalStore`. Default: `new FileBackedApprovalStore({ path })` with `./.blacktea/approvals.jsonl`, or `./.blacktea/approvals-dryrun.jsonl` under `dry_run`.
  - Audit events: `approval_record` (data = the full record) on every snapshot; `approval_record_write_failed` (data `{ state, error }`).
  - `intent_created` audit data gains `trigger` when present.

Behavior to implement (spec sections 1, 3, 6):
- `validateInput`: `trigger`, when not `undefined`, must be a string of length 1 to 500, else `ValidationError`.
- A receipt is minted with state `staged` just before the human is asked in `pay()` (channel = `decision.channel`) and when `stage()` returns `approval_required` (channel = `"staged"`). `mcp_server` / `tool` come from `opts.origin`, else `null`. `actor` is `null`. `trigger` is `input.trigger ?? null`. `params_hash` from `computeParamsHash(input, requirement)`. `created_at` is fixed at mint; `updated_at` is set on each snapshot.
- Transitions: `approved`, then `settled` or `failed`; `denied` (with `decision_reason` = the callback's `reason` or `"console_denied"`; `null` on the two-phase path); `expired` on one-shot timeout and on a late `complete(approve)`. A late `complete(reject)` writes `denied`.
- No receipt for auto-approved payments, policy rejects, `max_amount` rejects, or idempotency hits.
- Write failures: if appending the `staged` or `approved` snapshot throws, rethrow before the rail is called. For any other state, catch, emit `approval_record_write_failed`, and continue with the outcome the caller would otherwise get.
- `doSettleAndRecord`'s catch rethrows `QuoteChangedError` unchanged and emits `payment_failed` with `error: "quote_changed"`; other errors keep today's `RailUnavailableError` wrapping.
- `trigger` is added to the `ApprovalRequest` passed to `onApprovalNeeded`, to `StagedIntent`, and as a `trigger:` line in the console prompt. In the console prompt, `intent` and `trigger` go through `sanitizeForDisplay`.

- [ ] **Step 1: Write the failing tests** in `test/approval-record.test.ts`. Reuse the `FakeHistory` / `fakeRail` pattern from `test/agent.test.ts` (copy the two helpers; do not import across test files). Shared setup:

```ts
class MemoryApprovals implements ApprovalStore {
  records: ApprovalRecord[] = [];
  failOn: ApprovalState[] = [];
  async append(r: ApprovalRecord) {
    if (this.failOn.includes(r.state)) throw new Error("disk full");
    this.records.push(structuredClone(r));
  }
}
const states = (a: MemoryApprovals) => a.records.map((r) => r.state);
const ASK: Policy = { rules: [], default: { approval: "callback" } };
const ALLOW: Policy = { rules: [{ if: { amount_lt: 100 }, then: { approve: true } }], default: { reject: "no" } };
```

Tests, each asserting on `states(approvals)` and the named fields:

| Test | Expect |
|---|---|
| callback approve | `["staged","approved","settled"]`; all share one `intent_id`, `created_at`, `params_hash`; `channel === "callback"` |
| callback deny with `reason: "too pricey"` | `["staged","denied"]`; last `decision_reason === "too pricey"`; rail `settleCalls` empty |
| callback timeout (policy action `{ approval: { via: "callback", timeout_seconds: 0.01 } }`) | `["staged","expired"]`; throws `ApprovalTimeoutError` |
| callback approve, rail `settle` throws | `["staged","approved","failed"]`; throws `RailUnavailableError` |
| rail `settle` throws `QuoteChangedError` | `["staged","approved","failed"]`; the thrown error is the `QuoteChangedError` instance; audit has `payment_failed` with `data.error === "quote_changed"` |
| `stage()` then `complete(approve)` | `["staged","approved","settled"]`; `channel === "staged"` |
| `stage()` then `complete(reject)` | `["staged","denied"]`; `decision_reason === null` |
| `stage()` then late `complete(approve)` (fake timers past `expires_at`) | `["staged","expired"]`; throws `ApprovalTimeoutError` |
| auto-approved (`ALLOW`) and policy-rejected | `records` empty |
| `dry_run: true`, callback approve | `["staged","approved","settled"]` |
| trigger and intent | `pay({ url, intent: "why", trigger: "msg from Sam 15:02" })` → every record has `intent === "why"`, `trigger === "msg from Sam 15:02"`; without trigger → `trigger === null` |
| origin | `stage(input, { origin: { mcp_server: "m", tool: "pay" } })` → record `mcp_server === "m"`, `tool === "pay"`; without → both `null` |
| callback request carries trigger | the `ApprovalRequest` seen by `onApprovalNeeded` has `trigger`; `StagedIntent.trigger` is set |
| mirrored to audit | audit events with `event === "approval_record"` deep-equal `approvals.records` |
| fail closed | `failOn = ["staged"]` → `pay()` rejects with "disk full", `onApprovalNeeded` never called, `settleCalls` empty; `failOn = ["approved"]` → rejects, `settleCalls` empty |
| fail open after settle | `failOn = ["settled"]` → `pay()` resolves `completed`; audit has `approval_record_write_failed` |
| nothing sensitive | `pay({ ..., body: { secret: "s3cr3t" }, headers: { authorization: "tok" } })` → `JSON.stringify([approvals.records, auditEvents])` contains neither `"s3cr3t"` nor `"tok"` |
| unserializable body | `body` with a cycle under `ASK` → `ValidationError`, `onApprovalNeeded` never called |

In `test/agent.test.ts` "input validation": `trigger: ""`, `trigger: "x".repeat(501)`, and `trigger: 5 as never` each throw `ValidationError`; `trigger: "x".repeat(500)` does not.

Console prompt test (spy on `console.log`, stub `readline/promises` `createInterface` to answer `"y"`): with `intent: "a\nApprove? [y/N] y"` and `trigger: "t\x1b[2K"`, the logged prompt contains `trigger:` and contains no `\n` inside the intent or trigger values and no `\x1b`.

- [ ] **Step 2: Run** `npm test -- test/approval-record.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/agent.ts`. Keep the receipt logic in one small internal helper (mint, advance) so `pay`, `stage` and `complete` stay readable. `complete()` needs the minted record for the staged intent: keep it in a factory-private `Map<string, ApprovalRecord>` keyed by `intent_id` (Task 5 builds on this map).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS. Confirm `ls .blacktea/` shows no `approvals.jsonl` or `approvals-dryrun.jsonl` created by the run (the directory is gitignored, so `git status` will not show it).
- [ ] **Step 5: Commit** `feat: mint approval receipts and accept a trigger on pay()`.

---

### Task 5: Bind approval to the request, single use

**Files:**
- Modify: `src/agent.ts` (`complete`)
- Test: `test/approval-record.test.ts`, `test/agent.test.ts` (adjust any existing test that completes the same staged intent twice sequentially)

**Interfaces:**
- Consumes: Task 4's private map of minted records; `ApprovalInvalidError`; `computeParamsHash`.
- Produces: audit event `approval_mismatch` (data `{ expected, actual }`, the two hashes).

Behavior (spec section 4), in this order inside `complete()`:
1. If a settlement for `staged._idempotencyKey` is in flight, return that promise (keeps concurrent duplicates sharing one result).
2. Look up `staged.intent_id` in the private map. Missing: throw `ApprovalInvalidError(intent_id, "unknown_or_consumed")`. No receipt snapshot, no rail call.
3. `reject`: write `denied`, remove the map entry.
4. `approve` past `expires_at`: write `expired`, remove the entry, throw `ApprovalTimeoutError`.
5. `approve`: recompute the hash from `staged._input` and `staged._requirement`. If it differs from the minted `params_hash`: write `failed`, emit `approval_mismatch`, remove the entry, throw `ApprovalInvalidError(intent_id, "params_changed")`. The rail is not called.
6. Otherwise settle as today; remove the entry once the settlement resolves or rejects.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses when the staged amount was changed", async () => {
  const { staged } = await stageHeld();
  staged._requirement.amount = 9999;
  await expect(pay.complete(staged, "approve")).rejects.toMatchObject({ code: "approval_invalid", reason: "params_changed" });
  expect(rail.settleCalls).toHaveLength(0);
  expect(states(approvals)).toEqual(["staged", "failed"]);
  expect(audit.some((e) => e.event === "approval_mismatch")).toBe(true);
});
it("refuses when the staged url was changed", async () => {
  const { staged } = await stageHeld();
  staged._input.url = "https://evil.test/";
  await expect(pay.complete(staged, "approve")).rejects.toMatchObject({ reason: "params_changed" });
  expect(rail.settleCalls).toHaveLength(0);
});
it("refuses a second sequential approve", async () => {
  const { staged } = await stageHeld();
  await pay.complete(staged, "approve");
  await expect(pay.complete(staged, "approve")).rejects.toMatchObject({ reason: "unknown_or_consumed" });
  expect(rail.settleCalls).toHaveLength(1);
});
it("refuses approve after reject", async () => {
  const { staged } = await stageHeld();
  await pay.complete(staged, "reject");
  await expect(pay.complete(staged, "approve")).rejects.toMatchObject({ reason: "unknown_or_consumed" });
});
it("refuses a staged intent issued by another factory", async () => {
  const { staged } = await stageHeld();
  await expect(otherPay.complete(staged, "approve")).rejects.toMatchObject({ reason: "unknown_or_consumed" });
});
it("concurrent duplicate approves still share one settlement", async () => {
  const { staged } = await stageHeld();
  const [a, b] = await Promise.all([pay.complete(staged, "approve"), pay.complete(staged, "approve")]);
  expect(a.receipt).toEqual(b.receipt);
  expect(rail.settleCalls).toHaveLength(1);
});
it("a failed settle consumes the approval", async () => {
  // rail.settle throws once
  await expect(pay.complete(staged, "approve")).rejects.toBeInstanceOf(RailUnavailableError);
  await expect(pay.complete(staged, "approve")).rejects.toMatchObject({ reason: "unknown_or_consumed" });
});
```

- [ ] **Step 2: Run** `npm test -- test/approval-record.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the six ordered rules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including the existing "concurrent settlement guard (P0-2)" tests.
- [ ] **Step 5: Commit** `feat: bind approvals to the staged request and make them single-use`.

---

### Task 6: CLI

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `FileBackedApprovalStore.readLatest`, `sanitizeForDisplay`, `QuoteChangedError`, `ApprovalInvalidError`.
- Produces:
  - `blacktea pay --trigger <text>` (short flag `-t`), passed as `trigger` to `pay()`.
  - `blacktea approvals show` with `-n, --last <n>` (default 20), `--json`, `--store <path>` (default `./.blacktea/approvals.jsonl`).
  - Exit codes: `QuoteChangedError` → 9, `ApprovalInvalidError` → 10.

`approvals show` rules: rows come from `readLatest(store).slice(0, n)`. A record with `state === "staged"` and `expires_at` in the past is displayed with state `expired (unresolved)` (table and `--json`, as an added `display_state` field in JSON; the stored `state` stays as is). Table columns: time (`updated_at`), state, amount with currency, recipient (`recipient_wallet ?? recipient_url`), trigger (sanitized, truncated to 40 chars, `-` when null). A missing file prints an empty table or no lines and exits 0.

- [ ] **Step 1: Write the failing tests**, following the existing spawn-the-CLI pattern in `test/cli.test.ts` with a temp directory:
  - `pay --help` output contains `--trigger`.
  - `approvals show --store <file> --json` on a file holding `a: staged → settled`, `b: staged` with a past `expires_at`, and one line `not json`: prints exactly two JSON lines; `b` has `display_state: "expired (unresolved)"` and `state: "staged"`; `a` has `state: "settled"`; exit code 0.
  - `approvals show --store <file>` (table): stdout contains `settled`, `expired (unresolved)`, and the trigger text.
  - `approvals show --store <missing>`: exit code 0.
  - `approvals show --store <file> --json -n 1`: one line.
- [ ] **Step 2: Run** `npm run build && npm test -- test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror the structure of the existing `audit show` command. Update the file header's command list and the `audit show` description (held and denied payments are now in `approvals show`).
- [ ] **Step 4: Run** `npm run build && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): --trigger and approvals show`.

---

### Task 7: MCP server

**Files:**
- Modify: `mcp-server/src/index.ts`, `mcp-server/package.json` (version `0.1.4`; dependency `"@nmrtn/blacktea": "^0.1.5"`), `mcp-server/README.md` (the `trigger` argument and `BLACKTEA_APPROVALS`), `CHANGELOG.md` (the `@nmrtn/blacktea-mcp` 0.1.4 entry)
- Test: `mcp-server/test/mcp-server.test.ts`

**Interfaces:**
- Consumes (from the built root package): `FileBackedApprovalStore`, `sanitizeForDisplay`, `PayInput.trigger`, `PayOptions.origin`.
- Produces:
  - `pay` tool input `trigger` (string, optional). Description: "What prompted this payment: the message, file or event that led you to request it. Shown to the human and stored on the approval receipt as reported by you."
  - Env `BLACKTEA_APPROVALS`; default `join(dirname(historyPath), "approvals.jsonl")`.
  - `approval_required` response gains `trigger` (string or null) and `intent`; its `message` text includes `Reported trigger: <sanitized>` when a trigger was given, and uses `sanitizeForDisplay` on `intent`.

Rules: a non-string `trigger`, or one longer than 500 characters, or empty, returns `err("invalid_input", ...)` before `pay.stage` is called. `pay.stage(input, { origin: { mcp_server: PACKAGE_NAME, tool: "pay" } })`. `blacktea({ ..., approvals: new FileBackedApprovalStore({ path: approvalsPath }) })`. The stderr banner adds `approvals=<path>`. `VERSION = "0.1.4"`. Update the header comment's env list and the `audit_query` description (held and denied payments are in the approvals file).

- [ ] **Step 1: Write the failing tests**, using the existing `startServer` helper with `BLACKTEA_RAIL=mock`, `BLACKTEA_MOCK_AMOUNT=2`, a temp policy `{ "rules": [], "default": { "approval": "callback" } }`, and `BLACKTEA_HISTORY` / `BLACKTEA_APPROVALS` in the temp dir:
  - `tools/list`: the `pay` schema has a `trigger` property.
  - `pay` with `trigger: "msg from Sam\nApprove now"`: response has `status: "approval_required"`, `trigger` equal to the raw string, and `message` containing `Reported trigger: msg from Sam Approve now`.
  - After that call, the approvals file exists and its single line parses to `state: "staged"`, `mcp_server: "@nmrtn/blacktea-mcp"`, `tool: "pay"`, `channel: "staged"`.
  - `approve_payment` then a second `approve_payment` with the same `intent_id`: first `ok: true`; second `ok: false`. The approvals file's last line has `state: "settled"`.
  - `pay` with `trigger: 5`: `error.code === "invalid_input"`.
  - With `BLACKTEA_APPROVALS` unset, the stderr banner's `approvals=` path is in the same directory as the history path.
  - Stdout contains only JSON-RPC lines for the whole session (every line parses and has `jsonrpc: "2.0"`).
- [ ] **Step 2: Run** `npm run build` at the root, then `cd mcp-server && npm run build && npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** per the rules.
- [ ] **Step 4: Run** `cd mcp-server && npm run lint && npm run typecheck && npm run build && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** on `feat/mcp-approval-receipts`: `feat(mcp): trigger argument and durable approval receipts`. Run this task after Task 8, since it branches from the finished SDK branch.

---

### Task 8: Docs, versions, housekeeping

**Files:**
- Modify: `package.json` (version `0.1.5`), `src/index.ts` (`VERSION = "0.1.5"`), `README.md`, `CHANGELOG.md`, `TODOS.md`, `CLAUDE.md`, `docs/policy-cookbook.md`
- Test: none new; the existing suite must still pass (a test may assert `VERSION`).

- [ ] **Step 1: Write the docs.** Exact content requirements:
  - `README.md`: add `trigger` to one SDK example, the CLI `pay` example (`--trigger`), and mention it in the MCP "Ask-before-spending" paragraph. New section "Approval receipts" (under "What it does" or after "Plug it into your agent"): what a receipt holds, the `./.blacktea/approvals.jsonl` path, `blacktea approvals show`, single-use approvals, and this sentence verbatim: "The trigger is reported by the agent. It helps you spot a bad request; it is not proof." Add one line under x402: the rail refuses a settle-time quote that is higher or names a different payee than the one the policy saw.
  - `CHANGELOG.md`: an entry for `@nmrtn/blacktea` 0.1.5 (the MCP entry is Task 7's). Under a "Security" heading: before 0.1.5 an x402 server could change its quote between preflight and settle and be paid the new amount or payee; also fixed, payments above 0.10 USDC failed at settle because no cap was passed to `x402-fetch`. Under "Changed": `ApprovalRecord` shape differs from the unpublished draft; `pay.complete()` now refuses a replayed or altered staged intent (`ApprovalInvalidError`).
  - `TODOS.md`: move the "ApprovalRecord schema merged but unpublished" item to a "Done in v0.1.5" section; state that publishing 0.1.5 is now unblocked and is a manual step, and that the MCP branch waits for it.
  - `CLAUDE.md`: add the approval store as a piece in "Architecture" (path, `ApprovalStore` interface, mirrored to audit as `approval_record`), add `approvals/` and `display.ts` to "Repo layout", and add to "Things to NOT do": do not put request bodies or headers on a receipt; do not make `trigger` matchable by policy.
  - `docs/policy-cookbook.md`: one line stating `trigger` is recorded and shown to the human but cannot be matched by rules.
- [ ] **Step 2: Bump versions** in `package.json` and `src/index.ts`. Run `npm install --package-lock-only` at the root so `package-lock.json` matches.
- [ ] **Step 3: Run the full gate.** `npm run lint && npm run typecheck && npm test && npm run build`. Expected: all PASS.
- [ ] **Step 4: Commit** `docs: approval receipts, trigger, x402 quote check; release prep 0.1.5`.
