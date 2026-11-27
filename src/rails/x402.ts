/**
 * x402 rail adapter.
 *
 * Wraps the x402-fetch V1 client behind blacktea's RailAdapter interface.
 *
 *   preflight(): make the initial request, expect 402, parse the
 *                accepts[] array, return a PaymentRequirement.
 *   settle():    use wrapFetchWithPayment(fetch, signer, maxValue, selector)
 *                to sign and retry. It pays only the approved quote:
 *                maxValue is the approved amount in base units, and the
 *                selector refuses (QuoteChangedError, nothing signed) any
 *                settle-time option whose payee differs from the preflight
 *                quote, whose amount is higher, or that is not on the
 *                configured chain and token. A lower price to the same
 *                payee is accepted and recorded.
 *                Parse the x-payment-response settlement header into a
 *                Receipt; return the response body as data.
 *
 * The server's quote names the network and token contract that get
 * signed, so both are checked against the configured ones at preflight and
 * again at settle: a wallet set up for a testnet never signs a mainnet
 * payment, and never a token other than the expected one.
 *
 * v1 knows USDC on Base Sepolia / Base. For another chain or token, set
 * `asset` (and `asset_decimals`, `currency`) on the config.
 */

import { NetworkError, QuoteChangedError, RailUnavailableError } from "../errors.js";
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
   * Quotes on any other network are refused.
   */
  chain: string;
  /**
   * Contract address of the token to pay in. Quotes in any other token are
   * refused. Defaults to USDC for "base" and "base-sepolia"; required for
   * any other chain.
   */
  asset?: string;
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
  const expectedAsset = cfg.asset ?? USDC_BY_CHAIN[cfg.chain];

  // Lazy-load x402-fetch. It pulls in a large dependency tree (viem,
  // metamask/walletconnect, etc.) at module load. Importing it only when a
  // payment actually settles keeps startup fast: building the adapter,
  // preflighting (which uses global fetch), and running the policy never touch
  // it. This matters for MCP hosts that spawn the server and expect a quick
  // handshake. A cold static import can blow past their connect timeout.
  type X402Mod = typeof import("x402-fetch");
  let modPromise: Promise<X402Mod> | null = null;
  function loadX402(): Promise<X402Mod> {
    if (!modPromise) modPromise = import("x402-fetch");
    return modPromise;
  }

  let signerPromise: Promise<Awaited<ReturnType<X402Mod["createSigner"]>>> | null = null;
  function ensureSigner() {
    if (!signerPromise) {
      signerPromise = loadX402().then((mod) => mod.createSigner(cfg.chain, cfg.privateKey));
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

      const offered = listAccepts(body);
      if (offered.length === 0) {
        throw new RailUnavailableError(
          railName,
          `402 response from ${input.url} did not include an "accepts" array.`,
        );
      }
      if (expectedAsset === undefined) {
        throw new RailUnavailableError(
          railName,
          `No token is known for chain "${cfg.chain}". Set "asset" on the x402Wallet config.`,
        );
      }
      const accepts = offered.find(
        (entry) => chainMismatch(entry, cfg.chain, expectedAsset) === undefined,
      );
      if (!accepts) {
        throw new RailUnavailableError(
          railName,
          `402 response from ${input.url} offered no payment option on ${cfg.chain} in token ${expectedAsset}.`,
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
      const approvedQuote = asAcceptEntry(requirement.raw);
      let approvedBaseUnits: bigint;
      try {
        approvedBaseUnits =
          approvedQuote?.maxAmountRequired !== undefined
            ? BigInt(String(approvedQuote.maxAmountRequired))
            : BigInt(Math.round(requirement.amount * 10 ** decimals));
      } catch (err) {
        throw new RailUnavailableError(
          railName,
          `Could not convert the approved amount to base units: ${(err as Error).message}`,
        );
      }

      // The entry the selector accepted, i.e. what is actually signed. Set
      // only when x402-fetch calls the selector (on a 402 at settle time).
      let accepted: AcceptEntry | undefined;
      const selectApprovedQuote = <T extends AcceptEntry>(entries: T[]): T => {
        let firstMismatch: string | undefined;
        for (const entry of entries) {
          const mismatch =
            chainMismatch(entry, cfg.chain, expectedAsset) ??
            quoteMismatch(entry, requirement.recipient_wallet, approvedBaseUnits);
          if (mismatch === undefined) {
            accepted = entry;
            return entry;
          }
          firstMismatch ??= mismatch;
        }
        throw new QuoteChangedError(
          railName,
          firstMismatch ?? "the server offered no payment option",
        );
      };

      const { wrapFetchWithPayment } = await loadX402();
      const signer = await ensureSigner();
      const fetchWithPayment = wrapFetchWithPayment(
        fetch,
        signer,
        approvedBaseUnits,
        selectApprovedQuote,
      );

      let response: Response;
      try {
        response = await fetchWithPayment(input.url, {
          method: input.method ?? "GET",
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
      } catch (err) {
        if (err instanceof QuoteChangedError) throw err;
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

      // Read the body once as text, then try to parse it as JSON. Not all
      // paid endpoints return JSON; when parsing fails we keep the raw text
      // so the caller still receives what they paid for (an empty body
      // becomes undefined).
      const rawBody = await response.text();
      let data: unknown;
      try {
        data = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
      } catch {
        data = rawBody;
      }

      const { txHash } = parseSettlementHeader(response.headers.get("x-payment-response"));

      // The receipt records the amount that was signed: the accepted
      // settle-time entry when there was one, else the approved quote. The
      // payee is always the approved one (the selector accepts no other,
      // comparing case-insensitively), in the casing history and policy use.
      const paidAmount = accepted
        ? Number(accepted.maxAmountRequired) / 10 ** decimals
        : requirement.amount;

      const receipt: Receipt = {
        id: txHash ?? `x402_${Date.now()}`,
        amount: paidAmount,
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

// USDC contract per chain, as in x402's own chain config.
const USDC_BY_CHAIN: Record<string, string> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

interface AcceptEntry {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string | number;
  resource?: string;
  payTo?: string;
  asset?: string;
  [key: string]: unknown;
}

function asAcceptEntry(raw: unknown): AcceptEntry | undefined {
  return raw && typeof raw === "object" ? (raw as AcceptEntry) : undefined;
}

/**
 * Why a payment option is not on the configured chain and token, or
 * undefined when it is. The network and token contract in a quote are what
 * gets signed, so a quote that names others is never payable.
 */
function chainMismatch(
  entry: AcceptEntry,
  chain: string,
  asset: string | undefined,
): string | undefined {
  if (entry.network !== chain) {
    return `network ${String(entry.network)} is not the configured ${chain}`;
  }
  if (
    typeof entry.asset !== "string" ||
    asset === undefined ||
    entry.asset.toLowerCase() !== asset.toLowerCase()
  ) {
    return `asset ${String(entry.asset)} is not the configured ${String(asset)}`;
  }
  return undefined;
}

/**
 * Why a settle-time payment option differs from the approved quote, or
 * undefined when it may be signed. The payee must match (letter case
 * ignored) and the amount must not exceed what was approved.
 */
function quoteMismatch(
  entry: AcceptEntry,
  approvedPayee: string | undefined,
  approvedBaseUnits: bigint,
): string | undefined {
  if (
    typeof entry.payTo !== "string" ||
    approvedPayee === undefined ||
    entry.payTo.toLowerCase() !== approvedPayee.toLowerCase()
  ) {
    return `payTo ${String(entry.payTo)} is not the approved ${String(approvedPayee)}`;
  }
  let amount: bigint;
  try {
    amount = BigInt(String(entry.maxAmountRequired));
  } catch {
    return `maxAmountRequired ${String(entry.maxAmountRequired)} is not an integer`;
  }
  if (amount > approvedBaseUnits) {
    return `maxAmountRequired ${amount} is above the approved ${approvedBaseUnits}`;
  }
  return undefined;
}

function listAccepts(body: unknown): AcceptEntry[] {
  if (!body || typeof body !== "object") return [];
  const accepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts)) return [];
  return accepts.filter((entry): entry is AcceptEntry => !!entry && typeof entry === "object");
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
