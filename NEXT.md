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

## Friction notes (after the quickstart, 2026-05-26)

### x402 quickstart notes

End-to-end payment settled on Base Sepolia. Tx hash:
`0xeba79551339df19c2b83cf6673201bb3b3e93889c7772b93045bafb54fe9b2f9`

Wallet used for the test (testnet only, do not reuse for real funds):
`0xAB3b4e2B25b4598a598385afe741f2d9b55DfD99`

Same wallet was both buyer and seller. Net cost was gas only.

### Surprises

1. **Two parallel package families** for x402 exist on npm.
   - `x402-fetch`, `x402-axios`, `x402-express`, etc (no scope) are V1.
   - `@x402/fetch`, `@x402/evm`, etc (scoped) are V2.
   They use different protocol versions and **do not interoperate.** A V2
   buyer fed a V1 response just returns the 402 without retrying.
   Use V1 on both sides until the ecosystem fully migrates. Today
   `x402-express` is still V1, so we match the buyer to V1 too.

2. **The default testnet facilitator URL** is
   `https://x402.org/facilitator`, not anything under coinbase.com.
   x402-express uses it by default if you do not pass one. We had been
   guessing the wrong URL based on the docs site domain.

3. **The 402 response shape (V1)** has these fields the rail needs to
   read in `preflight()`:
   ```json
   {
     "x402Version": 1,
     "accepts": [{
       "scheme": "exact",
       "network": "base-sepolia",
       "maxAmountRequired": "10000",
       "resource": "http://localhost:4021/protected",
       "payTo": "0xAB3b...",
       "maxTimeoutSeconds": 60,
       "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
       "extra": {...}
     }]
   }
   ```
   `maxAmountRequired` is in token base units (10000 = 0.01 USDC since
   USDC has 6 decimals). The asset field is the USDC contract address
   on Base Sepolia.

4. **The settlement header on the response is `x-payment-response`**.
   Base64-encoded JSON with `{ success, transaction, network, payer }`.
   That `transaction` field is the on-chain tx hash blacktea's Receipt
   should record.

### Decisions for T5 (the x402 rail adapter)

These are now grounded, not guessed:

1. **Use `x402-fetch@1` as the dependency.** The library exports two
   things we need: `createSigner(network, privateKey)` and
   `wrapFetchWithPayment(fetch, signer)`.

2. **`x402Wallet({ privateKey, chain })` factory** returns a RailAdapter
   that holds a Signer (built via `createSigner("base-sepolia", pk)`).

3. **`preflight(input)` implementation:**
   - Make an HTTP request to `input.url` with the unwrapped fetch
   - If status is 402, parse the body, pull the first `accepts` entry
   - Convert `maxAmountRequired` from token base units to a JS number
     (using the asset's decimals; for USDC that is 6)
   - Return `{ amount, currency: "USDC", recipient_wallet: payTo,
     network, raw: <the full accepts[0]> }`

4. **`settle(input, requirement, opts)` implementation:**
   - Use `wrapFetchWithPayment(fetch, signer)` to call `input.url`
   - That handles the signing + retry automatically
   - On the 200 response, parse `x-payment-response` header
   - Build a Receipt with `rail_charge_id = settlement.transaction`,
     plus the standard fields
   - Return `{ receipt, data: <response body> }`

5. **Error handling:** if the response is 4xx other than 402, throw a
   RailUnavailableError with the body. If signing throws, also
   RailUnavailableError. NetworkError for fetch failures.

6. **Currency decimals:** v1 hardcodes 6 for USDC on Base Sepolia.
   When more networks/assets land in v2, this becomes a lookup.

7. **`supports(input)`:** returns true if `input.url` starts with `http`.
   That is the loose check. The real "does this URL support x402"
   answer only comes back from preflight; the rail accepts any URL and
   the 402 verifies fitness.

### Cleanup before T5

- Delete `examples/x402-quickstart/.env` (the testnet key is fine to
  share but no reason to ship a working private key in git history).
- Decide whether to keep the quickstart in the repo as the seed of T9
  (the demo) or move it elsewhere.
