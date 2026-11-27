/**
 * In-memory test doubles shared by the factory tests. No file system, no
 * network.
 */

import { hostOf } from "../../src/host.js";
import type {
  AuditEvent,
  HistoryFilter,
  HistoryRecord,
  HistoryStore,
  PayInput,
  PayOptions,
  PaymentRequirement,
  RailAdapter,
  Receipt,
  SettleResult,
} from "../../src/types.js";

export class FakeHistory implements HistoryStore {
  events: HistoryRecord[] = [];
  async record(event: HistoryRecord): Promise<void> {
    this.events.push(event);
  }
  async sumSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number> {
    return this.events.filter((e) => match(e, opts.filter)).reduce((acc, e) => acc + e.amount, 0);
  }
  async countSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number> {
    return this.events.filter((e) => match(e, opts.filter)).length;
  }
  async prune(): Promise<number> {
    const len = this.events.length;
    this.events = [];
    return len;
  }
}

function match(e: HistoryRecord, filter: HistoryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.wallet && e.recipient_wallet?.toLowerCase() !== filter.wallet.toLowerCase()) {
    return false;
  }
  if (filter.url && (!e.recipient_url || hostOf(e.recipient_url) !== filter.url)) return false;
  return true;
}

/**
 * A configurable rail used only in tests. Default behaviour:
 *   - supports() returns true
 *   - preflight() returns a fixed PaymentRequirement (amount 4, wallet 0xabc)
 *   - settle() returns a fake receipt and a "fake data" body
 *
 * Override any of those by passing a partial behavior object. Tracks
 * settle() calls for assertion.
 */
export function fakeRail(
  name = "x402",
  behavior: {
    supports?: (input: PayInput) => boolean;
    preflight?: (input: PayInput) => Promise<PaymentRequirement>;
    settle?: (input: PayInput, req: PaymentRequirement, opts: PayOptions) => Promise<SettleResult>;
  } = {},
): RailAdapter & {
  settleCalls: Array<{ input: PayInput; req: PaymentRequirement }>;
  preflightCalls: PayInput[];
} {
  const settleCalls: Array<{ input: PayInput; req: PaymentRequirement }> = [];
  const preflightCalls: PayInput[] = [];

  const defaultPreflight = async (input: PayInput): Promise<PaymentRequirement> => {
    preflightCalls.push(input);
    return {
      amount: 4,
      currency: "USDC",
      recipient_wallet: "0xabc123",
      network: "base-sepolia",
    };
  };

  const defaultSettle = async (input: PayInput, req: PaymentRequirement): Promise<SettleResult> => {
    settleCalls.push({ input, req });
    const receipt: Receipt = {
      id: "rail_receipt_id",
      amount: req.amount,
      currency: req.currency,
      rail: name,
      rail_charge_id: "ch_test_123",
      recipient_url: input.url,
      recipient_wallet: req.recipient_wallet,
      paid_at: new Date().toISOString(),
    };
    return { receipt, data: { fake: "api response" } };
  };

  const rail: RailAdapter & {
    settleCalls: typeof settleCalls;
    preflightCalls: typeof preflightCalls;
  } = {
    name,
    supports: behavior.supports ?? (() => true),
    preflight: behavior.preflight
      ? async (input) => {
          preflightCalls.push(input);
          return behavior.preflight ? behavior.preflight(input) : defaultPreflight(input);
        }
      : defaultPreflight,
    settle: behavior.settle
      ? async (input, req, opts) => {
          settleCalls.push({ input, req });
          return behavior.settle ? behavior.settle(input, req, opts) : defaultSettle(input, req);
        }
      : defaultSettle,
    settleCalls,
    preflightCalls,
  };
  return rail;
}

export function collectingAudit(): { sink: (e: AuditEvent) => void; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: (e) => events.push(e), events };
}
