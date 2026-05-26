/**
 * Tiny x402 seller. Exposes one paid endpoint that costs 0.01 USDC.
 *
 * Run with: npm run seller
 * Then point the buyer at http://localhost:4021/protected
 */

import dotenv from "dotenv";
import express from "express";
import { paymentMiddleware } from "x402-express";

dotenv.config();

const port = Number(process.env.SELLER_PORT ?? 4021);
const recipient = process.env.SELLER_RECEIVING_ADDRESS as `0x${string}` | undefined;
const facilitatorUrl = (process.env.FACILITATOR_URL ?? "https://x402.coinbase.com") as `${string}://${string}`;

if (!recipient || !recipient.startsWith("0x")) {
  console.error("SELLER_RECEIVING_ADDRESS is missing or invalid. Set it in .env.");
  process.exit(1);
}

const app = express();

// Note: the exact API shape of paymentMiddleware may differ in the
// version you install. If this errors at import time, check the
// x402-express README for the current signature and update this file.
app.use(
  paymentMiddleware(
    recipient,
    {
      "GET /protected": {
        price: "$0.01",
        network: "base-sepolia",
      },
    },
    { url: facilitatorUrl },
  ),
);

app.get("/protected", (_req, res) => {
  res.json({
    message: "Hello, paid customer.",
    timestamp: new Date().toISOString(),
  });
});

app.listen(port, () => {
  console.log(`x402 seller listening on http://localhost:${port}`);
  console.log(`Try in another terminal:  npm run buyer`);
  console.log(`Or with curl (will get 402): curl http://localhost:${port}/protected`);
});
