/**
 * Mock rail adapter.
 *
 * A RailAdapter that does no network calls and no signing. Returns a
 * configurable PaymentRequirement from preflight() and a synthetic
 * receipt from settle(). Useful for:
 *
 *   - Trying blacktea in 30 seconds without wiring x402, a wallet, or USDC
 *   - Local dev / CI where you want to exercise the policy engine
 *     end to end without touching the network
 *   - Demos / talks where you want to show pay() working without
 *     setting up a testnet wallet
 *
 * DO NOT use this in production. It does not actually move money.
 * It is the "express your policy on fake payments" path.
 */

import type {
  PayInput,
  PayOptions,
  PaymentRequirement,
  RailAdapter,
  Receipt,
  SettleResult,
} from "../types.js";

export interface MockWalletConfig {
  /**
   * The amount the simulated server will ask for in preflight. Default 0.01.
   * If you set this above your policy's threshold the approval flow fires;
   * if you set it above max_amount the call rejects pre-policy.
   */
  amount?: number;
  /** Currency code reported on the receipt. Default "USDC". */
  currency?: string;
  /** Fake recipient wallet returned in preflight. Default a 0xMOCK… string. */
  recipient_wallet?: string;
  /** Network field reported in preflight. Default "mock". */
  network?: string;
  /**
   * What settle() should return as the API response body. Default is a
   * small JSON object. Set this if you want pay() to return the kind of
   * shape your real API returns (chat completion, dataset row, etc).
   */
  responseData?: unknown;
  /**
   * If true, supports() always returns false. Used to test the
   * NoEligibleRailError branch in factory wiring.
   */
  unsupported?: boolean;
  /**
   * Adapter name reported via rail.name. Defaults to "mock". Override
   * if you need to distinguish multiple mock rails in audit logs.
   */
  name?: string;
}

const DEFAULT_RECIPIENT = "0xMOCK000000000000000000000000000000000000";

/**
 * Build a mock RailAdapter. No network, no signing, no money.
 * See MockWalletConfig for what's configurable.
 *
 * Example:
 *
 *     import { blacktea } from "@nmrtn/blacktea";
 *     import { mockWallet } from "@nmrtn/blacktea/adapters";
 *
 *     const pay = blacktea({
 *       source: mockWallet({ amount: 0.5 }),
 *       policy: "./policy.json",
 *     });
 *     const intent = await pay({
 *       url: "https://example.com/api",
 *       intent: "test the policy",
 *     });
 *     console.log(intent.receipt);
 *     // { id: "mock_<timestamp>", amount: 0.5, currency: "USDC",
 *     //   rail: "mock", rail_charge_id: "mock_charge_<timestamp>",
 *     //   simulated: true, ... }
 */
export function mockWallet(cfg: MockWalletConfig = {}): RailAdapter {
  const amount = cfg.amount ?? 0.01;
  const currency = cfg.currency ?? "USDC";
  const recipient_wallet = cfg.recipient_wallet ?? DEFAULT_RECIPIENT;
  const network = cfg.network ?? "mock";
  const responseData = cfg.responseData ?? {
    message: "Hello from the mock rail.",
    timestamp: new Date().toISOString(),
  };
  const railName = cfg.name ?? "mock";
  const unsupported = cfg.unsupported ?? false;

  return {
    name: railName,

    supports(_input: PayInput): boolean {
      return !unsupported;
    },

    async preflight(_input: PayInput): Promise<PaymentRequirement> {
      return {
        amount,
        currency,
        recipient_wallet,
        network,
      };
    },

    async settle(
      input: PayInput,
      requirement: PaymentRequirement,
      _opts: PayOptions,
    ): Promise<SettleResult> {
      const now = Date.now();
      const receipt: Receipt = {
        id: `mock_${now}`,
        amount: requirement.amount,
        currency: requirement.currency,
        rail: railName,
        rail_charge_id: `mock_charge_${now}`,
        recipient_wallet: requirement.recipient_wallet,
        recipient_url: input.url,
        paid_at: new Date(now).toISOString(),
        simulated: true,
      };
      return { receipt, data: responseData };
    },
  };
}
