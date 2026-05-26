# IDEAS.md

Things we want to remember but are deliberately not building yet.
None of this is in v0.1. All of it has been considered and parked.

---

## Soft policy: an LLM judge on top of the deterministic rules

Idea raised 2026-05-26 by Nicolas during the launch-planning conversation.

### The pitch

In addition to `policy.json` (hard, deterministic rules), the customer
writes a `policy.md` in natural language. An LLM judge reads it and
evaluates ambiguous payments that the hard rules flagged for approval.
The judge returns one of: approve, reject, or escalate to human, with
a reason that goes into the audit log.

### Why it is interesting

- Catches semantic mismatches the rules engine cannot:
  - Intent text vs URL mismatch ("research data" paying nike.com)
  - Newly registered or sketchy domains
  - Cross-field consistency (amount unusually high for the kind of
    service named in the intent)
- Markdown is friendlier than JSON for non-technical writers.
- Reduces approval-prompt fatigue when most flagged payments are
  obviously fine.

### Why it is not v0.1

- Non-determinism in a safety library is hard to defend.
- LLM latency (500ms to 3s) hurts the x402 "instant" feel.
- Cost-vs-payment ratio breaks for micropayments (LLM call may cost
  10% of the payment itself for tiny x402 charges).
- Prompt injection: the agent's `intent` string is attacker-controlled
  in some setups; a naive judge prompt would fall for it.
- v0.1 needs the trust story to be "deterministic rules, 132 tests,
  predictable" not "an LLM thinks it is fine."

### Architecture sketch

Strictly additive. Hard rules run first. The judge only fires when
hard rules return `approval`.

```
payment intent
  |
  v
hard rules (policy.json)
  |
  +-> allow            -> settle
  +-> reject           -> throw PolicyDeniedError
  +-> approval needed  -> LLM judge with policy.md
                            |
                            +-> soft approve  -> settle
                            +-> soft reject   -> throw with reasoning
                            +-> escalate      -> existing
                                                 onApprovalNeeded
                                                 callback
```

### What policy.md might look like

```markdown
# Spending policy

## Things to allow without bothering me
- API services I have an existing relationship with.
- Data subscriptions in my work area.
- Recurring payments under €50 to vendors I have paid before.

## Things to ask me about
- Any new vendor I have not paid before.
- Subscriptions to media or entertainment.
- Anything over €500.

## Things to refuse outright
- URLs registered in the last 30 days.
- Payments where the intent does not match the recipient.
- Anything that smells like a phishing attempt.

## When in doubt
Ask me. I would rather be interrupted than have you guess wrong.
```

### Naming

Not "policy" (already taken by the rules engine). Suggested terms:

- `judge` (preferred): clear metaphor, distinct from rules
- `soft policy` vs `hard policy`: clean dichotomy
- `LLM validator`: accurate but bland

Hard and soft layers, clearly named.

### When to actually build it

After the launch (post v0.1), when at least two of these signal:

- Real users complaining about approval-prompt fatigue
- A specific request for natural-language policy from someone
  building agents at scale
- The deterministic story is mature and trust-tested in the wild
- We have time to harden against prompt injection (strict response
  schema, intent sanitization, judge prompt with hard boundaries)
- We have a clear position on cost (off by default? configurable
  model? customer-supplied API key?)

Until then, parked.

### Open design questions to revisit when we pick this up

- Which model is the default? (gpt-4o-mini, claude-haiku, ...
  customer-configurable?)
- How does the judge get its context? Just the intent + policy.md,
  or also recent history, recipient reputation, etc?
- Does the judge see the agent's own justification text, and if so
  how do we sanitize it against injection?
- What is the failure mode when the judge is unreachable? (Fail
  closed, escalate to human, fail open?)
- Does the audit log store the full judge reasoning, or just the
  decision + a hash?
- Pricing/cost story for users who run blacktea at scale?

---

## (Add other parked ideas below this line as they come up)
