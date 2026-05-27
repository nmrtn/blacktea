# x402 quickstart

The truth check before T5. Spins up a local seller and a buyer that pays it
0.01 USDC over Base Sepolia testnet. If this runs end to end, the protocol
works the way the docs claim and we know how to wire it into blacktea.

Estimated time: 30-45 minutes including signup.

## Prereqs you need to do once

These steps happen on the Coinbase website. They cannot be scripted.

### 1. Create a Coinbase Developer Platform account

Visit https://portal.cdp.coinbase.com/ and sign up. Free tier is enough.

### 2. Generate or import a Base Sepolia wallet

In the CDP portal, either generate a new wallet or paste a private key you
already have. Copy the private key (it starts with `0x`). Save the wallet's
address too. You will paste both into `.env` shortly.

For the test, you can use the same wallet as BOTH buyer and seller. The buyer
sends 0.01 USDC, the seller (same wallet) receives it, net cost is just gas.

### 3. Get testnet funds from the faucet

Visit https://portal.cdp.coinbase.com/products/faucet and request:

- Base Sepolia ETH (for gas; you need a small amount)
- Base Sepolia USDC (the payment asset; 1 USDC is plenty for many tests)

These take a few seconds to show up. Check the wallet balance in the portal.

### 4. (Optional) Find the right facilitator URL

The default in `.env.example` is `https://x402.coinbase.com`. If Coinbase has
moved it, the current URL is in the docs at
https://docs.cdp.coinbase.com/x402/quickstart-for-sellers.

## Run it

```bash
cd examples/x402-quickstart
cp .env.example .env
# edit .env: paste EVM_PRIVATE_KEY and SELLER_RECEIVING_ADDRESS (your wallet)

npm install

# Terminal 1: seller
npm run seller
# expect: "x402 seller listening on http://localhost:4021"

# Terminal 2: buyer
npm run buyer
# expect: "HTTP 200" and "Response body: { message: 'Hello, paid customer.' ... }"
# plus a settlement header showing the chain tx hash.
```

## Verify on chain

The settlement should land within seconds. Copy the tx hash from the buyer's
output (it appears in the settlement header or in the seller's logs). Look it
up on Base Sepolia's explorer:

https://sepolia.basescan.org/tx/<tx_hash>

You should see a USDC transfer of 0.01 from the buyer wallet to the seller's
receiving address.

## What this teaches us for T5

Notes for when you start the rail adapter:

1. **What the 402 response actually looks like.** Print the response object
   when the buyer first calls the URL. The `x-402-version`, the `accepts`
   array, the `payTo` address, the `maxAmountRequired`, the `network`.
2. **What `wrapFetchWithPayment` does behind the scenes.** Read the source if
   the docs are thin. Specifically: how does it pick a scheme, how does it
   sign, how does it carry the signature.
3. **What the settlement response looks like.** The `x-payment-response`
   header. Decoded, what fields does it have? That is what the receipt is
   built from.
4. **What fails.** Wrong network. Missing funds. Wrong facilitator URL.
   Whatever you hit during the quickstart, capture it. Those are the
   `RailUnavailableError` messages T5 will produce.

## When you are done

Delete `.env` (or at least never commit it; the `.gitignore` at the repo root
already covers `.env` files). Keep the wallet around for T5 development.

If everything ran cleanly, T5 should take 1-2 hours of coding. The rail
adapter's `preflight()` makes the GET, parses the 402; `settle()` calls
`wrapFetchWithPayment` (or signs manually) and returns the body.

If something broke, document it before moving on. Future you needs the notes.
