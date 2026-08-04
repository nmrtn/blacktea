/**
 * Public adapter exports for @nmrtn/blacktea/adapters.
 *
 * Customers import rail factories from here, not from the root package.
 * Keeps unused rail clients out of the main bundle.
 */

export { x402Wallet } from "../rails/x402.js";
export type { X402WalletConfig } from "../rails/x402.js";

export { ledgerGuardReview, ledgerGuardX402Wallet } from "../rails/ledger-guard.js";
export type { LedgerGuardConfig } from "../rails/ledger-guard.js";

export { mockWallet } from "../rails/mock.js";
export type { MockWalletConfig } from "../rails/mock.js";
