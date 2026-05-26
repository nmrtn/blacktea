/**
 * x402 rail adapter.
 *
 * Wraps the x402-fetch V1 client behind blacktea's RailAdapter interface.
 *
 *   preflight(): make the initial request, expect 402, parse the
 *                accepts[] array, return a PaymentRequirement.
 *   settle():    use wrapFetchWithPayment(fetch, signer) to sign and
 *                retry. Parse the x-payment-response settlement header
 *                into a Receipt; return the response body as data.
 *
 * v1 hardcoded for USDC on Base Sepolia / Base. When more assets land,
 * the currency + decimals lookup becomes a table keyed on the asset
 * contract address.
 */

import { createSigner, wrapFetchWithPayment } from "x402-fetch";
import { NetworkError, RailUnavailableError } from "../errors.js";
import type {
  PayInput,
  PayOptions,
  PaymentRequirement,
  RailAdapter,
  Receipt,
  SettleResult,
} from "../types.js";

export interface X402WalletConfig {
  /**
   * 0x-prefixed EVM private key. The wallet does the signing for
   * payments and must hold testnet (or mainnet) USDC and ETH for gas.
   */
  privateKey: string;
  /**
   * Network identifier accepted by x402-fetch's createSigner. v1 was
   * tested on "base-sepolia"; "base" should work too with mainnet USDC.
   */
  chain: string;
  /**
   * Asset decimals used to convert maxAmountRequired (in base units)
   * to a JS number. Defaults to 6 (USDC). Override only if you point
   * the adapter at a non-USDC asset.
   */
  asset_decimals?: number;
  /**
   * Reported currency code on receipts. Defaults to "USDC".
   */
  currency?: string;
}

/**
 * Build a RailAdapter that uses x402-fetch under the hood. The signer
 * is initialised lazily on the first preflight/settle so the factory
 * itself stays synchronous.
 */
export function x402Wallet(cfg: X402WalletConfig): RailAdapter {
  const decimals = cfg.asset_decimals ?? 6;
  const currency = cfg.currency ?? "USDC";
  const railName = "x402";

  let signerPromise: ReturnType<typeof createSigner> | null = null;
  function ensureSigner() {
    if (!signerPromise) {
      signerPromise = createSigner(cfg.chain, cfg.privateKey);
    }
    return signerPromise;
  }

  return {
    name: railName,

    supports(input: PayInput): boolean {
      return (
        typeof input.url === "string" &&
        (input.url.startsWith("http://") || input.url.startsWith("https://"))
      );
    },

    async preflight(input: PayInput): Promise<PaymentRequirement> {
      let response: Response;
      try {
        response = await fetch(input.url, {
          method: input.method ?? "GET",
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
      } catch (err) {
        throw new NetworkError(`x402 preflight fetch failed: ${(err as Error).message}`, err);
      }

      if (response.status !== 402) {
        throw new RailUnavailableError(
          railName,
          `Expected HTTP 402 from ${input.url}, got HTTP ${response.status}. The endpoint may not be x402-enabled.`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        throw new RailUnavailableError(
          railName,
          `402 response from ${input.url} was not valid JSON: ${(err as Error).message}`,
        );
      }

      const accepts = pickFirstAccept(body);
      if (!accepts) {
        throw new RailUnavailableError(
          railName,
          `402 response from ${input.url} did not include an "accepts" array.`,
        );
      }

      const amountRaw = String(accepts.maxAmountRequired);
      const amount = Number(amountRaw) / 10 ** decimals;
      if (!Number.isFinite(amount)) {
        throw new RailUnavailableError(
          railName,
          `Could not parse maxAmountRequired="${amountRaw}" as a number.`,
        );
      }

      return {
        amount,
        currency,
        ...(typeof accepts.payTo === "string" ? { recipient_wallet: accepts.payTo } : {}),
        ...(typeof accepts.network === "string" ? { network: accepts.network } : {}),
        raw: accepts,
      };
    },

    async settle(
      input: PayInput,
      requirement: PaymentRequirement,
      _opts: PayOptions,
    ): Promise<SettleResult> {
      const signer = await ensureSigner();
      const fetchWithPayment = wrapFetchWithPayment(fetch, signer);

      let response: Response;
      try {
        response = await fetchWithPayment(input.url, {
          method: input.method ?? "GET",
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
      } catch (err) {
        throw new RailUnavailableError(railName, `x402 settle failed: ${(err as Error).message}`);
      }

      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const text = await response.text();
          if (text) detail += `: ${text.slice(0, 300)}`;
        } catch {
          // ignore body read failures; status is enough
        }
        throw new RailUnavailableError(railName, `settle returned non-OK: ${detail}`);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        // Not all paid endpoints return JSON. Fall back to text.
        data = undefined;
      }

      const { txHash } = parseSettlementHeader(response.headers.get("x-payment-response"));

      const receipt: Receipt = {
        id: txHash ?? `x402_${Date.now()}`,
        amount: requirement.amount,
        currency: requirement.currency,
        rail: railName,
        ...(txHash ? { rail_charge_id: txHash } : {}),
        ...(requirement.recipient_wallet ? { recipient_wallet: requirement.recipient_wallet } : {}),
        recipient_url: input.url,
        paid_at: new Date().toISOString(),
      };

      return { receipt, data };
    },
  };
}

// ---------- helpers ----------

interface AcceptEntry {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string | number;
  resource?: string;
  payTo?: string;
  asset?: string;
  [key: string]: unknown;
}

function pickFirstAccept(body: unknown): AcceptEntry | null {
  if (!body || typeof body !== "object") return null;
  const accepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const first = accepts[0];
  if (!first || typeof first !== "object") return null;
  return first as AcceptEntry;
}

function parseSettlementHeader(header: string | null): { txHash?: string } {
  if (!header) return {};
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as {
      transaction?: string;
    };
    if (typeof decoded.transaction === "string") {
      return { txHash: decoded.transaction };
    }
    return {};
  } catch {
    return {};
  }
}
