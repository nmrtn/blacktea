# Rail adapter sketches

blacktea's `RailAdapter` interface is two methods plus `name` and `supports`. Every payment rail (x402, virtual cards, SEPA push, AP2) implements the same interface, so the policy DSL, approval flow, audit log, and idempotency guard are rail-agnostic. The current shipped adapter is `x402Wallet`. This doc sketches three more (Stripe Issuing for cards, Tink PSD2 for SEPA Instant, and AP2 for the emerging agent-payments protocol) so the rail-pluggable claim has a concrete shape, not just a hand-wave.

These are **design sketches, not production code.** Real implementations will refine field names, error handling, and provider-specific quirks. They are accurate enough to argue with.

## The contract

From `src/types.ts`:

```typescript
export interface RailAdapter {
  name: string;
  supports(input: PayInput): boolean;
  preflight(input: PayInput): Promise<PaymentRequirement>;
  settle(input: PayInput, requirement: PaymentRequirement, opts: PayOptions): Promise<SettleResult>;
}
```

Key idea: **preflight learns the price; settle moves the money.** For request-response rails (x402, AP2) preflight probes the server for a 402-style answer. For agent-tells-blacktea rails (cards, SEPA push) preflight echoes back the structured input the agent provided. blacktea's policy evaluator runs between the two, so it sees a normalized `PaymentRequirement` regardless of where it came from.

## Status

| Rail | Status | Package | Sketch |
|---|---|---|---|
| **x402** (USDC on Base) | Shipped | `@nmrtn/blacktea/adapters` | (production code) |
| **mock** (no network) | Shipped | `@nmrtn/blacktea/adapters` | (production code) |
| **Stripe Issuing** (cards) | Sketch | `@nmrtn/blacktea-stripe-issuing` (planned) | below |
| **PSD2** (SEPA Instant) | Sketch | `@nmrtn/blacktea-tink`, `@nmrtn/blacktea-bridge` (planned) | below |
| **AP2** (Google + Coinbase) | Sketch, awaiting spec | `@nmrtn/blacktea-ap2` (planned) | below |
| **ACH** via Plaid | Open | n/a | n/a |
| **ACP** | Open | n/a | n/a |

## Sketch 1: Stripe Issuing (cards)

**Model: per-payment single-use virtual cards.** The agent calls `pay()` with a merchant URL and amount. blacktea evaluates the policy. If allow, blacktea mints a new Stripe Issuing virtual card pinned to that amount via `spending_controls`, and returns the card credentials as the response `data`. The agent uses those credentials with whatever it uses for checkout (browser automation, merchant API, AP2 later). The merchant charges the card. Stripe's network-level controls reject anything that violates the pin.

Where blacktea's scope ends: at issuance. The chain-of-custody for the card credentials after `pay()` returns is the agent runtime's problem, not blacktea's. blacktea is the *credential gate*, not the *checkout driver*.

```typescript
import Stripe from "stripe";
import type {
  RailAdapter,
  PayInput,
  PaymentRequirement,
  SettleResult,
  Receipt,
} from "@nmrtn/blacktea";

interface StripeIssuingConfig {
  /** Restricted Stripe key with Issuing scope. */
  stripeKey: string;
  /** Pre-created Stripe cardholder (the human or org behind the agent). */
  cardholder_id: string;
  /** Default currency for cards minted by this adapter. */
  default_currency?: string;
}

export function stripeIssuingWallet(cfg: StripeIssuingConfig): RailAdapter {
  const stripe = new Stripe(cfg.stripeKey);
  const railName = "stripe-issuing";

  return {
    name: railName,

    supports: (input) => /^https?:/.test(input.url),

    async preflight(input: PayInput): Promise<PaymentRequirement> {
      // No 402-style probe for cards. The agent provides the amount
      // explicitly (via input.body.amount or input.max_amount); blacktea
      // normalizes that into a PaymentRequirement so the policy engine
      // sees the same shape as for any other rail.
      const amount = (input.body as { amount?: number } | undefined)?.amount ?? input.max_amount;
      if (typeof amount !== "number") {
        throw new Error("stripeIssuing: amount required in input.body.amount or input.max_amount");
      }
      const merchantHost = new URL(input.url).host;
      return {
        amount,
        currency: cfg.default_currency ?? "usd",
        // No real "recipient_wallet" for cards; we use the merchant host as
        // the recipient identifier so policy operators like wallet_in keep
        // working as domain-level allow/blocklists.
        recipient_wallet: merchantHost,
        network: "stripe-issuing",
        raw: { merchant_url: input.url },
      };
    },

    async settle(input, requirement): Promise<SettleResult> {
      // Mint a virtual card with a single-authorization spending limit at
      // exactly the requested amount. Stripe's network-level controls
      // reject any later authorization that exceeds the limit, so the
      // merchant cannot "accidentally" charge more than blacktea approved.
      const card = await stripe.issuing.cards.create({
        cardholder: cfg.cardholder_id,
        currency: requirement.currency,
        type: "virtual",
        status: "active",
        spending_controls: {
          spending_limits: [
            {
              amount: Math.round(requirement.amount * 100), // Stripe uses cents
              interval: "per_authorization",
            },
          ],
        },
      });

      // Card credentials are PCI-sensitive. Production code uses the
      // ephemeral-key flow from a frontend; for an agent context the
      // credentials live in the agent's memory only for the duration of
      // checkout and the card is consumed by the spending_limit above.
      const details = await stripe.issuing.cards.retrieve(card.id, {
        expand: ["number", "cvc"],
      });

      const receipt: Receipt = {
        id: card.id,
        amount: requirement.amount,
        currency: requirement.currency,
        rail: railName,
        rail_charge_id: card.id,
        recipient_url: input.url,
        recipient_wallet: requirement.recipient_wallet,
        paid_at: new Date().toISOString(),
      };

      // The "data" the agent receives is the card itself. The agent then
      // uses a browser tool (or a merchant API) to complete checkout. If
      // the merchant tries to charge more or somewhere else, Stripe's
      // spending_controls reject the authorization.
      return {
        receipt,
        data: {
          card_number: details.number,
          exp_month: card.exp_month,
          exp_year: card.exp_year,
          cvc: details.cvc,
          cardholder_name: card.cardholder, // expand the cardholder for the name in real code
          single_use: true,
          merchant_pin: input.url,
        },
      };
    },
  };
}
```

**Variant: auth-webhook mode (deferred to v1.5+).** Same Stripe Issuing foundation, but instead of minting a new card per payment, the user gives the agent an existing card and Stripe emits an authorization webhook on every charge. blacktea sits as the webhook handler, runs the policy, and approves or denies in real time. This unlocks "agent uses one card across many merchants" but requires blacktea to be deployed as a reachable web service, not the local stdio/library model it is today.

**Honest limits with cards:**
- Chargebacks exist. A "completed" PaymentIntent on the cards rail is reversible for up to ~120 days. Future `PaymentIntentStatus` will likely need a "revoked" or "charged_back" terminal state.
- Once the agent has the card credentials, the chain-of-custody is no longer blacktea's. Combine with a browser-use tool that runs in an isolated context if you care about credential exfiltration.

## Sketch 2: PSD2 (SEPA Credit Transfer Instant)

**Model: PSD2 Payment Initiation Service.** The user authorizes a Payment Initiation Service provider once via Strong Customer Authentication. The PIS provider holds the OAuth token. blacktea calls the PIS provider's API to push SEPA Instant transfers from the user's account to a recipient IBAN. The agent never sees the user's bank credentials.

There are several licensed PIS providers with near-identical contracts: **Tink** (Visa-owned, broad European reach), **Bridge** (French, originally Bankin', deep French bank coverage, now part of BPCE), **TrueLayer** (UK + EU), **Salt Edge** (EU). The code below uses Tink as the concrete reference because its docs are public; a Bridge or TrueLayer adapter is a near drop-in replacement with different base URLs and slightly different consent-flow plumbing. Treat the sketch as the PSD2 *shape*; pick the provider that matches your geography and license setup.

This is the cleanest mapping to blacktea's existing model: same preflight/settle split, same buyer-side decision layer, different rail underneath.

```typescript
import type {
  RailAdapter,
  PayInput,
  PaymentRequirement,
  SettleResult,
  Receipt,
} from "@nmrtn/blacktea";

interface TinkPisConfig {
  client_id: string;
  client_secret: string;
  /** Consent id from a prior SCA flow. Tink holds the OAuth token; blacktea never does. */
  user_consent_id: string;
  /** The user's account that gets debited. */
  source_iban: string;
  source_bic?: string;
  /** Default to api.tink.com; override for sandbox. */
  api_base?: string;
}

interface TinkPaymentBody {
  recipient_iban: string;
  recipient_name: string;
  recipient_bic?: string;
  amount: number;
  remittance?: string;
}

export function tinkSepaWallet(cfg: TinkPisConfig): RailAdapter {
  const railName = "tink-sepa-instant";
  const base = cfg.api_base ?? "https://api.tink.com";

  async function getToken(): Promise<string> {
    const resp = await fetch(`${base}/api/v1/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        grant_type: "client_credentials",
        scope: "payment:write",
      }),
    });
    if (!resp.ok) throw new Error(`tink token: ${resp.status}`);
    return (await resp.json()).access_token;
  }

  return {
    name: railName,

    supports: (input) => {
      // Convention: agent provides destination IBAN in input.body.
      const body = input.body as TinkPaymentBody | undefined;
      return typeof body?.recipient_iban === "string";
    },

    async preflight(input: PayInput): Promise<PaymentRequirement> {
      const body = input.body as TinkPaymentBody;
      if (typeof body.amount !== "number") {
        throw new Error("tinkSepa: input.body.amount is required (EUR)");
      }
      return {
        amount: body.amount,
        currency: "EUR",
        recipient_wallet: body.recipient_iban, // IBAN as the recipient identifier
        network: "sepa-instant",
        raw: {
          recipient_name: body.recipient_name,
          recipient_bic: body.recipient_bic,
          remittance: body.remittance ?? input.intent.slice(0, 140),
        },
      };
    },

    async settle(input, requirement): Promise<SettleResult> {
      const token = await getToken();
      const raw = requirement.raw as {
        recipient_name: string;
        recipient_bic?: string;
        remittance: string;
      };
      const resp = await fetch(`${base}/payments/v2/payments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: { value: requirement.amount, currency: "EUR" },
          debtor: { iban: cfg.source_iban, bic: cfg.source_bic },
          creditor: {
            iban: requirement.recipient_wallet,
            name: raw.recipient_name,
            bic: raw.recipient_bic,
          },
          remittance_information: raw.remittance,
          consent_id: cfg.user_consent_id,
          scheme: "SEPA_INSTANT",
        }),
      });
      if (!resp.ok) throw new Error(`tink payment: ${resp.status}`);
      const payment = await resp.json();

      const receipt: Receipt = {
        id: payment.id,
        amount: requirement.amount,
        currency: "EUR",
        rail: railName,
        rail_charge_id: payment.id,
        recipient_url: input.url,
        recipient_wallet: requirement.recipient_wallet,
        paid_at: new Date().toISOString(),
      };

      // SEPA Instant typically confirms within ~10 seconds. The Tink
      // response shape includes a status; a real adapter would poll if
      // the response is "pending" before returning a terminal receipt.
      return { receipt, data: { tink_payment_id: payment.id, status: payment.status } };
    },
  };
}
```

**Sibling providers (same shape, different endpoints):**

- **Bridge** (`api.bridgeapi.io`): consent flow is end-user-token-based; payment initiation under `/v2/payments`. Strong on French bank coverage, including the BPCE group, Société Générale, BNP Paribas, Crédit Agricole, and the neobanks. The Bridge adapter would look identical to the sketch above with the auth and endpoint blocks swapped.
- **TrueLayer** (`api.truelayer.com`): payment initiation under `/v3/payments`; auth is a signed JWT bound to a JWKS.
- **Salt Edge** (`www.saltedge.com/api`): explicit `customer_id` + `connection_id` model.

All four implement the same PSD2 PIS shape; they differ in geography, bank coverage, fee model, and consent-flow specifics. For a French-focused agent, Bridge is the obvious first call. For broad EU + UK, Tink or TrueLayer.

**Honest limits with SEPA Instant:**
- Irrevocable once accepted. blacktea's "rejected" state must fire BEFORE settle; there is no chargeback path.
- ~10 second settlement window. Fits blacktea's current synchronous `pay()` model.
- EU only. For US users, the equivalent is RTP (The Clearing House) or FedNow; same architecture, different provider.
- Bank coverage varies. Not every European bank supports SCT Instant yet; preflight may need to check the recipient bank's capability before policy evaluation.

## Sketch 3: AP2 (Agent Payments Protocol)

**Model: emerging spec from Google + Coinbase + others.** AP2 aims to be the agent-native payment protocol, with structured payment instruments and explicit consent semantics. The spec is still being defined as of this writing, so this sketch is a placeholder showing the *shape* a blacktea adapter would take once the spec stabilizes. The likely shape is request-response (similar to x402), with the agent presenting a signed AP2 payment intent and the merchant returning a structured receipt.

```typescript
import type {
  RailAdapter,
  PayInput,
  PaymentRequirement,
  SettleResult,
  Receipt,
} from "@nmrtn/blacktea";

interface AP2Config {
  /** The user's pre-authorized payment instrument (card, bank, stablecoin). */
  payment_instrument: unknown; // shape TBD per AP2 spec
  network: "ap2-mainnet" | "ap2-testnet";
}

export function ap2Wallet(cfg: AP2Config): RailAdapter {
  const railName = "ap2";

  return {
    name: railName,

    supports: (input) => /^https?:/.test(input.url),

    async preflight(input: PayInput): Promise<PaymentRequirement> {
      // Expected (per current AP2 drafts): merchants surface a payment
      // requirement via an x-ap2-payment-required header or a 402 with
      // a structured body. Exact field names follow the spec.
      const resp = await fetch(input.url, { method: "HEAD" });
      const header = resp.headers.get("x-ap2-payment-required");
      if (!header) {
        throw new Error("ap2: endpoint did not advertise an AP2 payment requirement");
      }
      const required = JSON.parse(header);
      return {
        amount: required.amount,
        currency: required.currency,
        recipient_wallet: required.recipient,
        network: cfg.network,
        raw: required,
      };
    },

    async settle(input, requirement): Promise<SettleResult> {
      // Sign and present a payment per the AP2 spec. The exact signing
      // surface and header conventions follow the final spec.
      const signed = signAP2Payment(cfg.payment_instrument, requirement);
      const resp = await fetch(input.url, {
        method: input.method ?? "GET",
        headers: {
          "x-ap2-payment": signed,
          ...(input.headers ?? {}),
        },
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      });
      const data = await resp.json();

      const receiptId = resp.headers.get("x-ap2-receipt-id") ?? `ap2_${Date.now()}`;
      const receipt: Receipt = {
        id: receiptId,
        amount: requirement.amount,
        currency: requirement.currency,
        rail: railName,
        rail_charge_id: receiptId,
        recipient_url: input.url,
        recipient_wallet: requirement.recipient_wallet,
        paid_at: new Date().toISOString(),
      };

      return { receipt, data };
    },
  };
}

declare function signAP2Payment(instrument: unknown, req: PaymentRequirement): string;
```

**Honest limits with AP2:**
- Pre-spec. Exact field names, signing scheme, and consent flow may shift. This adapter materializes once the spec is stable.
- The buyer-side governance story (which is what blacktea adds) is precisely the same regardless of the wire-level details. The policy/approval/audit logic does not change.

## Want to build one?

The interface is small. The contract is well-defined. If you want SEPA, AP2, ACH, or a custom rail in a real package:

1. Open an issue tagged with the rail name. Describe the request-response shape (push? pull? webhook-driven?) and what the receipt should carry.
2. Reference this doc as the design starting point.
3. Ship the adapter as a sibling npm package (like `@nmrtn/blacktea-mcp`) or contribute to `src/rails/` if it's broadly useful.

Cross-pollination with the rail-providing teams is welcome and active. If you work at Stripe (Issuing), Coinbase (x402), the AP2 working group, or a PSD2 PIS provider (Bridge, Tink, TrueLayer, Salt Edge), we are happy to refine these sketches against your actual API.
