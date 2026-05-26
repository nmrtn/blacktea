# Next session

Read this first thing tomorrow. Two pages.

## Where we left off (2026-05-26)

109 tests green. Lane A done (scaffold, schema, evaluator, idempotency, history, factory). The library skeleton is functionally complete except for one thing: it does not yet talk to a real x402 facilitator. Every test uses a fake rail.

Read `CLAUDE.md` if you need the full context. Skip if you have it in your head.

## What to do, in order

### 1. Run the x402 quickstart (45-60 minutes)

This is the truth check. Coinbase's docs claim x402 is plug-and-play. The only way to know is to run it.

**Start here:**
- Official x402 docs: https://docs.cdp.coinbase.com/x402/welcome
- The quickstart guides: https://docs.cdp.coinbase.com/x402/quickstart-for-buyers and https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
- The npm clients: `x402-axios` (buyer side, what blacktea will use) and `x402-express` or `x402-hono` (seller side, for testing)

**What you need:**
- A free Coinbase Developer Platform account.
- A test wallet on Base Sepolia (testnet). You can generate one, or use CDP's faucet.
- Testnet ETH for gas (CDP faucet usually covers this).
- Testnet USDC (CDP faucet usually covers this too).
- About 60 minutes.

**Try this:**
1. Sign up at CDP, get an API key.
2. Run the buyer-side quickstart end to end. Get a real payment to settle on Base Sepolia.
3. Note the actual import paths, the actual function names, the actual response shapes. **Take notes in this file.** The shape we have in the design doc is from reading their docs months ago; the real API might have moved.
4. If anything is broken or unclear, write it down. That feedback shapes T5.

**Success criteria:** you have one real on-chain transaction hash to show.

### 2. Take 15 minutes to write the friction report

After the quickstart, write a few lines below the `### x402 quickstart notes` header in this file. Honest about what was easy and what was hard. Future you (and the README) will thank you.

### 3. Then start T5 (the x402 rail adapter)

T5 wires x402 into blacktea via the `RailAdapter` interface. Files to create:

```
src/rails/x402.ts        ← the x402Wallet() factory and the adapter
src/adapters/index.ts    ← public export surface @nmrtn/blacktea/adapters
test/rails/x402.test.ts  ← unit tests against a mocked HTTP client
```

The `RailAdapter` interface is now in two halves (preflight + settle):

- **`preflight(input: PayInput)`**: make the initial HTTP request to the URL.
  If the server returns 402, parse the `PAYMENT-REQUIRED` header into a
  `PaymentRequirement` (amount, currency, recipient_wallet, network). Return it.
- **`settle(input, requirement, opts)`**: sign the payment with the wallet, retry
  the request with `PAYMENT-SIGNATURE`, parse the server's response body and
  return `{ receipt, data }`. The factory writes receipt to history; data is
  whatever the API returned (chat completion, dataset, etc).

Verify after the quickstart that the V2 header names and payload shapes match
what x402-axios actually uses. If you decide to wrap x402-axios under the hood,
note that its `withPaymentInterceptor` signs automatically; you need to call it
in two phases or implement the protocol manually so the policy evaluator gets a
chance to inspect the amount before signing.

Most of the structure already exists in the `RailAdapter` shape in `src/types.ts`.
You are filling in the body of preflight + settle.

After T5, T7 (mock facilitator for tests), T8 (full PaymentIntent state machine), T9 (Claude Agent SDK demo).

### 4. The DM (15 minutes, any time this week)

Draft is in the design doc at `~/.gstack/projects/blacktea/nmrtn-agent-payments-design-20260522.md`. Look for the section called "The Assignment" near the bottom. Send to Panche Isajeski at AgentaOS via LinkedIn or X. The response (if any) shapes the rest of the week more than another hour of coding would.

## Commands you will need

```bash
# Run all tests
npm test

# Run a single test file
npm test -- test/agent.test.ts

# Run a single test
npm test -- -t "approval flow"

# Watch mode while developing
npm run test:watch

# Lint + format
npm run lint
npm run lint:fix

# Typecheck without emitting
npm run typecheck

# Build to dist/
npm run build
```

## Friction notes (fill in after the quickstart)

### x402 quickstart notes

(Write here after step 1 above.)

### Surprises

(Anything that did not match the docs.)

### Decisions for T5

(Anything that informs how the x402 adapter should be written.)
