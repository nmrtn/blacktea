/**
 * Themed x402 seller for the demo: a mock "AlphaFeed" premium data API.
 * Serves one paid endpoint that costs 0.01 USDC. Run: npm run seller
 */
import dotenv from "dotenv";
import express from "express";
import { paymentMiddleware } from "x402-express";

dotenv.config();

const port = Number(process.env.SELLER_PORT ?? 4021);
const recipient = process.env.SELLER_RECEIVING_ADDRESS as `0x${string}` | undefined;
const facilitatorUrl = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;

if (!recipient || !recipient.startsWith("0x")) {
  console.error("SELLER_RECEIVING_ADDRESS is missing or invalid. Set it in .env.");
  process.exit(1);
}

const ROUTE = "/reports/nvda-q1";

const app = express();

app.use(
  paymentMiddleware(
    recipient,
    {
      [`GET ${ROUTE}`]: {
        price: "$0.01",
        network: "base-sepolia",
      },
    },
    { url: facilitatorUrl },
  ),
);

app.get(ROUTE, (_req, res) => {
  res.json({
    provider: "AlphaFeed Premium Data",
    ticker: "NVDA",
    period: "Q1 FY2026",
    headline: "Data center revenue drives record quarter",
    revenue_usd_b: 44.1,
    yoy_growth_pct: 69,
    data_center_revenue_usd_b: 39.1,
    eps_diluted_usd: 0.81,
    gross_margin_pct: 71.3,
    next_q_revenue_guidance_usd_b: 45.0,
    note: "Sample premium dataset served for the blacktea x402 demo.",
    retrieved_at: new Date().toISOString(),
  });
});

app.listen(port, () => {
  console.log(`AlphaFeed (mock x402 seller) on http://localhost:${port}${ROUTE}`);
  console.log(`Priced at $0.01 USDC, network base-sepolia, recipient ${recipient}`);
});
