/**
 * Tiny x402 buyer (V1, paired with x402-express seller).
 *
 * Run with: npm run buyer  (the seller must be running on SELLER_PORT)
 */

import dotenv from "dotenv";
import { createSigner, wrapFetchWithPayment } from "x402-fetch";

dotenv.config();

const pk = process.env.EVM_PRIVATE_KEY;
if (!pk || !pk.startsWith("0x")) {
  console.error("EVM_PRIVATE_KEY is missing or invalid. Set it in .env.");
  process.exit(1);
}

const sellerPort = process.env.SELLER_PORT ?? 4021;
const url = `http://localhost:${sellerPort}/protected`;

const signer = await createSigner("base-sepolia", pk);
const fetchWithPayment = wrapFetchWithPayment(fetch, signer);

console.log(`Calling ${url} ...`);

const response = await fetchWithPayment(url, { method: "GET" });
console.log(`HTTP ${response.status}`);

const body = await response.json();
console.log("Response body:", body);

const settlementHeader = response.headers.get("x-payment-response");
if (settlementHeader) {
  try {
    const decoded = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf-8"));
    console.log("Settlement header decoded:", decoded);
  } catch {
    console.log("Settlement header (raw):", settlementHeader);
  }
}
