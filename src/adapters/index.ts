/**
 * Public adapter exports for @nmrtn/blacktea/adapters.
 *
 * Customers import rail factories from here, not from the root package.
 * Keeps unused rail clients out of the main bundle.
 */

export { x402Wallet } from "../rails/x402.js";
export type { X402WalletConfig } from "../rails/x402.js";
