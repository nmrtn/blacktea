/**
 * One-shot wallet generator for the quickstart.
 *
 * Run with: npx tsx generate-wallet.ts
 *
 * Prints a fresh Base Sepolia-compatible private key and its derived
 * address. Paste them into .env and into the CDP faucet form.
 *
 * This wallet exists only on your machine. Nobody else has the private
 * key. Do not put real money on this address. Treat it as a throwaway
 * for testnet only.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("\n=== Fresh Base Sepolia wallet ===\n");
console.log("Private key:", privateKey);
console.log("Address:    ", account.address);
console.log("\nPaste into examples/x402-quickstart/.env:");
console.log(`  EVM_PRIVATE_KEY=${privateKey}`);
console.log(`  SELLER_RECEIVING_ADDRESS=${account.address}`);
console.log("\nPaste the address into the CDP faucet's \"Send to\" field.");
console.log("Request both ETH (0.0001 is enough) AND USDC (the faucet token dropdown).");
console.log("\nThis wallet is testnet-only. Do not send real funds to it.\n");
