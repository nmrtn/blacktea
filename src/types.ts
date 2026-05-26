/**
 * Core types shared across the library.
 *
 * PaymentIntentInput is the shape the policy evaluator sees. The agent
 * provides amount, url, and intent. The library populates recipient_wallet
 * after receiving the x402 402 response (which announces the payTo address).
 * For the evaluator's purposes, treat all fields as already populated.
 */

export interface PaymentIntentInput {
  amount: number;
  currency?: string;
  url: string;
  intent: string;
  recipient_wallet?: string;
}

/**
 * HistoryQuery is the read interface the policy evaluator uses to answer
 * stateful operators (would_spend, amount_today_gte). The library's
 * default HistoryStore implements this against an append-only JSONL file.
 * Customers can swap for Redis, SQLite, etc.
 */
export interface HistoryQuery {
  sumSince(opts: {
    seconds: number;
    filter?: { wallet?: string; url?: string };
  }): Promise<number>;
  countSince(opts: {
    seconds: number;
    filter?: { wallet?: string; url?: string };
  }): Promise<number>;
}
