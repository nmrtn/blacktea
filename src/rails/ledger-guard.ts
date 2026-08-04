/**
 * LedgerGuard safety rail.
 *
 * Complements blacktea's spending controls (how much an agent may spend)
 * with LedgerGuard's transaction intent safety (who actually gets paid).
 *
 * Before any payment is signed, the engine reviews the real calldata:
 *   - recipient is not a zero address / seed-listed address
 *   - the decoded transfer matches the declared intent (recipient, amount, asset)
 *   - the call is safe to sign (fail-closed: unknown calls are never treated safe)
 *
 * Integration is a drop-in wrapper around the x402 rail:
 *
 *   import { ledgerGuardX402Wallet } from "@nmrtn/blacktea/ledger-guard";
 *
 *   const pay = blacktea({
 *     rail: ledgerGuardX402Wallet({
 *       privateKey: process.env.EVM_PRIVATE_KEY!,
 *       chain: "base",
 *       engineUrl: "https://ledgerguard-gules.vercel.app",
 *     }),
 *     policy: { ... },
 *   });
 *
 * The rail never receives the private key — LedgerGuard is a read-only
 * preflight reviewer; signing stays in blacktea's x402 signer.
 */

import { NetworkError, RailUnavailableError } from "../errors.js";
import type {
  PayInput,
  PayOptions,
  PaymentRequirement,
  RailAdapter,
  SettleResult,
} from "../types.js";
import { type X402WalletConfig, x402Wallet } from "./x402.js";

export interface LedgerGuardConfig extends X402WalletConfig {
  /**
   * LedgerGuard engine base URL. Defaults to the public demo deployment.
   */
  engineUrl?: string;
  /**
   * Network identifier the engine expects. Defaults to "baseMainnet".
   */
  engineNetwork?: string;
  /**
   * When true (default), a BLOCK from the engine aborts the payment.
   * Set false only to log-and-continue during evaluation.
   */
  failClosed?: boolean;
}

interface PreflightResult {
  decision: "ALLOW" | "REVIEW" | "BLOCK" | string;
  findings?: Array<{ code: string; severity: string; message: string }>;
}

/**
 * Review a payment against the LedgerGuard engine before anything signs.
 * Fail-closed: network errors and BLOCK decisions abort the payment.
 */
export async function ledgerGuardReview(
  cfg: Pick<LedgerGuardConfig, "engineUrl" | "engineNetwork" | "failClosed">,
  payment: {
    from: string;
    to: string;
    data?: string;
    valueWei?: string;
    amountMicroUsdc?: string;
    recipient?: string;
    purpose?: string;
    network?: string;
  },
): Promise<PreflightResult> {
  const baseUrl = (cfg.engineUrl ?? "https://ledgerguard-gules.vercel.app").replace(/\/$/, "");
  const network = payment.network ?? cfg.engineNetwork ?? "baseMainnet";

  const body = {
    network,
    from: payment.from,
    to: payment.to,
    ...(payment.data ? { data: payment.data } : {}),
    ...(payment.valueWei ? { valueWei: payment.valueWei } : {}),
    intent: {
      action: "transfer",
      expectedRecipient: payment.recipient ?? payment.to,
      expectedAssetAddress: payment.to,
      ...(payment.amountMicroUsdc ? { expectedAmountMicroUsdc: payment.amountMicroUsdc } : {}),
      ...(payment.purpose ? { purpose: payment.purpose } : {}),
    },
    policy: {},
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(`LedgerGuard preflight fetch failed: ${(err as Error).message}`, err);
  }

  let result: PreflightResult;
  try {
    result = (await response.json()) as PreflightResult;
  } catch {
    throw new RailUnavailableError(
      "ledger-guard",
      `LedgerGuard preflight returned non-JSON (HTTP ${response.status}).`,
    );
  }

  const failClosed = cfg.failClosed ?? true;
  const decision = result.decision ?? "UNKNOWN";
  if (failClosed && decision === "BLOCK") {
    const codes = (result.findings ?? []).map((f) => f.code).join(",");
    throw new RailUnavailableError(
      "ledger-guard",
      `LedgerGuard BLOCKED this payment (findings: ${codes || "unspecified"}).`,
    );
  }
  return result;
}

/**
 * Drop-in x402 rail wrapper that reviews every payment against LedgerGuard
 * before the x402 signer runs. Signing still happens locally via x402-fetch.
 */
export function ledgerGuardX402Wallet(cfg: LedgerGuardConfig): RailAdapter {
  const inner = x402Wallet(cfg);
  const engineUrl = cfg.engineUrl ?? "https://ledgerguard-gules.vercel.app";
  const engineNetwork = cfg.engineNetwork ?? "baseMainnet";

  return {
    name: "x402+ledger-guard",

    supports(input: PayInput): boolean {
      return inner.supports(input);
    },

    async preflight(input: PayInput): Promise<PaymentRequirement> {
      return inner.preflight(input);
    },

    async settle(
      input: PayInput,
      requirement: PaymentRequirement,
      opts: PayOptions,
    ): Promise<SettleResult> {
      // Review the real transaction before anything signs.
      await ledgerGuardReview(
        { engineUrl, engineNetwork, failClosed: cfg.failClosed },
        {
          from: (input as { from?: string }).from ?? "",
          to: (requirement as { recipient_wallet?: string }).recipient_wallet ?? "",
          ...(input.body ? { data: (input.body as { data?: string }).data } : {}),
          ...(requirement.amount !== undefined
            ? { amountMicroUsdc: String(Math.round(requirement.amount * 1_000_000)) }
            : {}),
          recipient: (requirement as { recipient_wallet?: string }).recipient_wallet,
          purpose: (input as { purpose?: string }).purpose ?? "blacktea agent payment",
        },
      );

      return inner.settle(input, requirement, opts);
    },
  };
}
