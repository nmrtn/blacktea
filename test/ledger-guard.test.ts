/**
 * LedgerGuard rail tests. These hit the public LedgerGuard engine over HTTP
 * (read-only preflight review; nothing is signed and no funds move).
 */

import { describe, expect, it } from "vitest";
import { ledgerGuardReview, ledgerGuardX402Wallet } from "../src/rails/ledger-guard.js";

// The public Vercel deployment keeps Base mainnet preflight behind a
// fail-closed gate (NETWORK_DISABLED until release gates pass). For real
// integration development, point at a locally enabled engine.
const ENGINE = process.env.LEDGERGUARD_ENGINE_URL ?? "http://localhost:3000";
const BUYER = "0xF1437d9CD304aE49f2ec005AC967813B3a7c466c";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MERCHANT = "0x4732d748a7dA766A0192adC2BBefC6041AAF9056";

function transferCalldata(to: string, amountMicro: number): string {
  return `0xa9059cbb${to.toLowerCase().replace(/^0x/, "").padStart(64, "0")}${BigInt(amountMicro)
    .toString(16)
    .padStart(64, "0")}`;
}

describe("ledgerGuardReview (real engine, read-only)", () => {
  it("reviews a normal merchant transfer and returns a decision", async () => {
    const result = await ledgerGuardReview(
      { engineUrl: ENGINE, engineNetwork: "baseMainnet" },
      {
        from: BUYER,
        to: USDC,
        data: transferCalldata(MERCHANT, 100000),
        amountMicroUsdc: "100000",
        recipient: MERCHANT,
        purpose: "blacktea integration test",
      },
    );
    expect(["ALLOW", "REVIEW", "BLOCK"]).toContain(result.decision);
  });

  it("blocks a zero-address recipient (fail-closed)", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    await expect(
      ledgerGuardReview(
        { engineUrl: ENGINE, engineNetwork: "baseMainnet" },
        {
          from: BUYER,
          to: USDC,
          data: transferCalldata(zero, 100000),
          amountMicroUsdc: "100000",
          recipient: zero,
          purpose: "blacktea integration test",
        },
      ),
    ).rejects.toThrow(/BLOCKED/i);
  });

  it("returns the engine decision without throwing when failClosed=false", async () => {
    const result = await ledgerGuardReview(
      { engineUrl: ENGINE, engineNetwork: "baseMainnet", failClosed: false },
      {
        from: BUYER,
        to: USDC,
        data: transferCalldata(MERCHANT, 100000),
        amountMicroUsdc: "100000",
        recipient: MERCHANT,
        purpose: "blacktea integration test",
      },
    );
    expect(result).toHaveProperty("decision");
  });
});

describe("ledgerGuardX402Wallet adapter", () => {
  it("exposes the x402-compatible rail surface", () => {
    const rail = ledgerGuardX402Wallet({
      privateKey: `0x${"11".repeat(32)}`,
      chain: "base",
      engineUrl: ENGINE,
    });
    expect(rail.name).toBe("x402+ledger-guard");
    expect(rail.supports({ url: "https://example.com/resource", intent: "test" })).toBe(true);
  });
});
