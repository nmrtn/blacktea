# Policy Cookbook

Ten real-world cases, written out as `policy.json` examples. Read top to bottom on your first pass. Use the reference at the bottom afterwards.

## Anatomy of a policy file

```json
{
  "time_zone": "Europe/Paris",
  "rules": [
    { "if": <condition>, "then": <action> }
  ],
  "default": <action>
}
```

- `time_zone`: optional. Defaults to `UTC` if absent. Used by time-of-day operators.
- `rules`: ordered list. **The library evaluates top to bottom. First match wins.**
- `default`: fires when no rule matches.

## The ordering convention (read this first)

The library evaluates rules top to bottom. The first matching rule decides the outcome. This makes ordering load-bearing. The safe convention is:

1. **Absolute caps first.** Rules that must never be bypassed (per-call max, sanctions).
2. **Conditional rejects next.** Rules with a deny outcome but a specific trigger (daily cap, blocklist).
3. **Allowlist short-circuits.** Trusted recipients that get auto-approved.
4. **Regular conditional rules.** Amount thresholds, time-of-day, intent matches.
5. **Default at the bottom.** Catchall for anything that did not match.

The library lints the file at load time. If an `approve` rule appears above a `reject` rule, you get a warning to the console. Not fatal. Just a heads-up.

---

## Case 1: auto-approve small in-budget calls

Most agent payments are small API calls. Approving each one by hand would defeat the point of having an agent.

```json
{
  "rules": [
    { "if": { "amount_lt": 10 }, "then": { "approve": true } }
  ],
  "default": { "approval": "callback" }
}
```

## Case 2: require approval over a threshold

Big payments should get a human in the loop. The default approval channel for production is `callback`, which calls your `onApprovalNeeded` function. For dev, use `console`.

```json
{
  "rules": [
    { "if": { "amount_gte": 100 }, "then": { "approval": "callback" } }
  ],
  "default": { "approve": true }
}
```

## Case 3: reject sanctioned recipients

Sanctioned wallets and known-bad URL prefixes never get paid.

```json
{
  "rules": [
    { "if": { "wallet_in": "./blocklists/sanctioned.txt" },         "then": { "reject": "sanctioned" } },
    { "if": { "url_starts_with": "https://sketchy.example.com" },   "then": { "reject": "blocked_domain" } }
  ],
  "default": { "approve": true }
}
```

A blocklist file is one entry per line. Comments allowed with `#`. Blank lines ignored.

```
# wallets.txt
0x1234abcd5678ef901234abcd5678ef9012345678
0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
```

## Case 4: rolling 24h spend cap

Total spent in the last 24 hours, across all recipients, cannot exceed a number.

Shorthand:

```json
{ "if": { "amount_today_gte": 500 }, "then": { "reject": "daily_cap" } }
```

Structured form (same meaning, more explicit):

```json
{
  "if": { "would_spend": { "window_hours": 24, "gte": 500 } },
  "then": { "reject": "daily_cap" }
}
```

The `would_spend` operator looks forward. It adds the current payment to the historical sum, then compares. A cap that only checked the past would fire one transaction late.

History is stored in a file (default `./.blacktea/history.jsonl`) so the cap survives process restarts.

## Case 5: time-of-day approval

Overnight, anything over a small amount requires approval. During the day, normal rules apply.

```json
{
  "time_zone": "Europe/Paris",
  "rules": [
    {
      "if": {
        "all": [
          { "time_of_day_between": ["22:00", "08:00"] },
          { "amount_gte": 20 }
        ]
      },
      "then": { "approval": "callback" }
    },
    { "if": { "amount_lt": 100 }, "then": { "approve": true } },
    { "if": { "amount_gte": 100 }, "then": { "approval": "callback" } }
  ],
  "default": { "approval": "callback" }
}
```

The boolean combinators are `all` (AND), `any` (OR), `not` (NOT). Each takes a list (or single condition for `not`).

Time windows wrap midnight if the end is earlier than the start. `["22:00", "08:00"]` means 22:00 today through 08:00 tomorrow.

## Case 6: allowlist short-circuit

Trusted recipients bypass everything below them.

```json
{
  "rules": [
    { "if": { "wallet_in": "./blocklists/sanctioned.txt" }, "then": { "reject": "sanctioned" } },

    { "if": { "wallet_in": "./allowlists/trusted-wallets.txt" }, "then": { "approve": true } },
    { "if": { "url_starts_with": "https://api.openai.com" },     "then": { "approve": true } },

    { "if": { "amount_lt": 10 },     "then": { "approve": true } },
    { "if": { "amount_gte": 100 },   "then": { "approval": "callback" } }
  ],
  "default": { "approval": "callback" }
}
```

Sanctions go first. Allowlist next. Sanctions always wins. If a wallet ends up on both lists by accident, the sanctions reject fires.

## Case 7: dry-run mode

Dry-run is a library-level flag, not a policy field. Same policy file, different runtime behaviour.

```typescript
const pay = blacktea({
  source: x402Wallet({ ... }),
  policy: "./policy.json",
  dry_run: process.env.BLACKTEA_DRY_RUN === "true",
});
```

When `dry_run: true`:

- Policy still evaluates fully.
- Approval flow still runs (so you can test the approval path too).
- Instead of calling the rail, the library logs `payment_simulated` and returns a fake receipt with `simulated: true`.
- History writes go to a separate file (`./.blacktea/history-dryrun.jsonl`) so dry-run does not pollute the live cap counters.
- Reject rules still throw `PolicyDeniedError`. Dry-run is "do not move money," not "pretend everything succeeds."

## Case 8: per-recipient rolling cap

Total cap is fine, but you also want a per-wallet cap. Even if there is daily budget left, no single wallet can receive more than €100 in a 24-hour window.

```json
{
  "if": {
    "would_spend": {
      "by": "wallet",
      "window_hours": 24,
      "gte": 100
    }
  },
  "then": { "reject": "per_wallet_cap" }
}
```

The `by` parameter:
- `"wallet"`: filter history to the current payment's recipient wallet.
- `"url"`: filter history to the current URL host.
- `"all"` or omitted: no filter, total across everything.

`"all"` is the default. The shorthand `amount_today_gte: N` desugars to `would_spend: { window_hours: 24, gte: N }` with no `by`.

## Case 9: maximum per-call hard cap

A single payment can never exceed a number. This rule goes at the very top so nothing else can override it.

```json
{
  "rules": [
    { "if": { "amount_gte": 10000 }, "then": { "reject": "absolute_cap" } },

    { "if": { "wallet_in": "./blocklists/sanctioned.txt" }, "then": { "reject": "sanctioned" } },
    { "if": { "wallet_in": "./allowlists/trusted-wallets.txt" }, "then": { "approve": true } },

    { "if": { "would_spend": { "window_hours": 24, "gte": 500 } }, "then": { "reject": "daily_cap" } },
    { "if": { "amount_lt": 10 },   "then": { "approve": true } },
    { "if": { "amount_gte": 100 }, "then": { "approval": "callback" } }
  ],
  "default": { "approval": "callback" }
}
```

The library linter warns at load time if you accidentally put an `approve` rule above a `reject` rule.

## Case 10: intent-string keyword approval

The agent passes an `intent` field with each payment, a free-form string explaining what the payment is for. You can match on keywords.

```json
{
  "if": { "intent_contains_any": ["transfer", "investment", "loan", "donation"] },
  "then": { "approval": "callback" }
}
```

Sibling operators:
- `intent_contains_all`: all words must appear.
- `intent_eq`: exact match.

Case-insensitive substring match. No regex in v1 (regex policies invite ReDoS). If you need richer classification, call your own LLM inside `onApprovalNeeded`.

The `intent` string is fuzzy by nature. The agent may say `"send funds to John"` or `"wire payment to vendor"` or `"buying tokens via API"`. Keyword matching is a coarse net, not a complete classifier. Use it as one signal among many.

---

## Operator reference

### Stateless (look only at the current payment)

| Operator | Shape | Description |
|---|---|---|
| `amount_lt` | `{ amount_lt: 10 }` | Current payment amount less than N |
| `amount_lte` | `{ amount_lte: 10 }` | Less than or equal |
| `amount_gt` | `{ amount_gt: 100 }` | Greater than |
| `amount_gte` | `{ amount_gte: 100 }` | Greater than or equal |
| `wallet_in` | `{ wallet_in: "./file.txt" }` or `{ wallet_in: ["0x...", "0x..."] }` | Recipient wallet matches an entry in the list |
| `url_starts_with` | `{ url_starts_with: "https://..." }` | Recipient URL begins with the prefix |
| `intent_contains_any` | `{ intent_contains_any: ["word", "word"] }` | Intent string contains any of the substrings (case-insensitive) |
| `intent_contains_all` | `{ intent_contains_all: ["word", "word"] }` | Intent string contains all of them |
| `intent_eq` | `{ intent_eq: "exact" }` | Exact match |
| `time_of_day_between` | `{ time_of_day_between: ["22:00", "08:00"] }` | Local time within the window (uses `time_zone` field) |

### Stateful (look at history; require the file-backed history store)

| Operator | Shape | Description |
|---|---|---|
| `would_spend` | `{ would_spend: { window_hours: 24, gte: 500, by: "wallet" } }` | Sum of (history + this payment) over the window matches the threshold |
| `amount_today_gte` (shorthand) | `{ amount_today_gte: 500 }` | Same as `would_spend: { window_hours: 24, gte: 500 }` |

### Combinators

| Operator | Shape |
|---|---|
| `all` | `{ all: [ <condition>, <condition>, ... ] }` |
| `any` | `{ any: [ <condition>, <condition>, ... ] }` |
| `not` | `{ not: <condition> }` |

## Action reference

| Action | Shape | Meaning |
|---|---|---|
| Auto-approve | `{ approve: true }` | Pay it. No human involved. |
| Require approval | `{ approval: "console" }` or `{ approval: "callback" }` | Call the approval channel before paying. `console` is a CLI prompt (dev). `callback` calls your `onApprovalNeeded` function (prod). |
| Reject | `{ reject: "reason_code" }` | Hard deny. Throws `PolicyDeniedError` to the caller. |

## Footguns

- **Rule ordering matters.** Put absolute caps at the top, then sanctions, then allowlist, then conditional rules. The library lints but does not auto-fix.
- **`time_zone` defaults to UTC.** If you do not set it, `time_of_day_between` runs in UTC, which is probably not what you want.
- **History is per-file, and there is no file locking.** Two processes writing the same history file can corrupt each other's writes (the default `FileBackedHistoryStore` appends without a lock). Give each agent process its own history path, or swap in a `HistoryStore` backed by Redis/SQLite for shared caps. Two processes with the SAME policy but DIFFERENT history files will not share daily caps.
- **Dry-run history is separate.** Dry-run mode writes to a different history file, so testing in dry-run does not exhaust your real daily cap.
- **Intent strings are fuzzy.** Keyword matching on free-form text is a coarse net. Do not assume it catches everything.
- **Reject codes are not enums.** They are arbitrary strings. Pick stable snake_case codes so you can grep them in logs.
