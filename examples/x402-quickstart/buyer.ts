/**
 * Tiny x402 buyer. Calls the local seller's paid endpoint.
 * The first request gets 402; the wrapped fetch signs the payment and
 * retries automatically. Prints the body and the settlement header.
 *
 * Run with: npm run buyer  (the seller must be running on SELLER_PORT)
 */

import dotenv from "dotenv";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config();

const pk = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk || !pk.startsWith("0x")) {
  console.error("EVM_PRIVATE_KEY is missing or invalid. Set it in .env.");
  process.exit(1);
}

const sellerPort = process.env.SELLER_PORT ?? 4021;
const url = `http://localhost:${sellerPort}/protected`;

const signer = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`Buyer wallet: ${signer.address}`);
console.log(`Calling ${url} ...`);

const response = await fetchWithPayment(url, { method: "GET" });
console.log(`HTTP ${response.status}`);

const body = await response.json();
console.log("Response body:", body);

// The seller may include a settlement header so the buyer can see the
// receipt details (chain tx hash, etc).
const settlementHeader = response.headers.get("x-payment-response");
if (settlementHeader) {
  try {
    const decoded = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf-8"));
    console.log("Settlement header decoded:", decoded);
  } catch (err) {
    console.log("Settlement header (raw):", settlementHeader);
  }
}
