/**
 * x402 rail adapter tests.
 *
 * Mocks the x402-fetch module so wrapFetchWithPayment is replaceable
 * per-test. Mocks global.fetch for the preflight path. No network.
 *
 * Integration tests against a real Base Sepolia facilitator live
 * outside the default suite (see examples/x402-quickstart).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pre-mock x402-fetch before importing the adapter.
const mockWrapFetchWithPayment = vi.fn();
const mockCreateSigner = vi.fn(async () => ({ __fake_signer: true }));

vi.mock("x402-fetch", () => ({
  createSigner: mockCreateSigner,
  wrapFetchWithPayment: mockWrapFetchWithPayment,
}));

// Now import after the mock is registered.
const { x402Wallet } = await import("../../src/rails/x402.js");
const { NetworkError, RailUnavailableError } = await import("../../src/errors.js");

const TEST_PK = "0x0000000000000000000000000000000000000000000000000000000000000001";

function make402Response(overrides: Record<string, unknown> = {}): Response {
  const body = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "10000",
        resource: "http://localhost:4021/protected",
        payTo: "0xRECIPIENT",
        maxTimeoutSeconds: 60,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        ...overrides,
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 402 });
}

function makeSettlementHeader(txHash: string): string {
  const settlement = {
    success: true,
    transaction: txHash,
    network: "base-sepolia",
    payer: "0xabc",
  };
  return Buffer.from(JSON.stringify(settlement)).toString("base64");
}

describe("x402Wallet", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockWrapFetchWithPayment.mockReset();
    mockCreateSigner.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("metadata", () => {
    it("has name 'x402'", () => {
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });
      expect(rail.name).toBe("x402");
    });

    it("supports http and https URLs", () => {
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });
      expect(rail.supports({ url: "http://localhost/foo", intent: "t" })).toBe(true);
      expect(rail.supports({ url: "https://api.example.com/foo", intent: "t" })).toBe(true);
    });

    it("does not support non-http schemes", () => {
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });
      expect(rail.supports({ url: "ftp://example.com", intent: "t" })).toBe(false);
      expect(rail.supports({ url: "wss://example.com", intent: "t" })).toBe(false);
    });
  });

  describe("preflight", () => {
    it("parses a 402 response into a PaymentRequirement", async () => {
      vi.mocked(fetch).mockResolvedValue(make402Response());
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      const req = await rail.preflight({ url: "https://x.com/paid", intent: "t" });

      expect(req.amount).toBe(0.01); // 10000 base units / 10^6 = 0.01
      expect(req.currency).toBe("USDC");
      expect(req.recipient_wallet).toBe("0xRECIPIENT");
      expect(req.network).toBe("base-sepolia");
      expect(req.raw).toMatchObject({ scheme: "exact" });
    });

    it("honours a custom decimals value", async () => {
      vi.mocked(fetch).mockResolvedValue(make402Response({ maxAmountRequired: "100" }));
      // 18 decimals e.g. ETH
      const rail = x402Wallet({
        privateKey: TEST_PK,
        chain: "base-sepolia",
        asset_decimals: 18,
      });

      const req = await rail.preflight({ url: "https://x.com/paid", intent: "t" });
      expect(req.amount).toBe(100 / 1e18);
    });

    it("throws RailUnavailableError when the response is not 402", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response("not paid", { status: 200 }));
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await expect(rail.preflight({ url: "https://x.com/paid", intent: "t" })).rejects.toThrow(
        RailUnavailableError,
      );
    });

    it("throws when the 402 body has no accepts array", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ x402Version: 1 }), { status: 402 }),
      );
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await expect(rail.preflight({ url: "https://x.com/paid", intent: "t" })).rejects.toThrow(
        /accepts/,
      );
    });

    it("throws when the 402 body is not JSON", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response("nope, not json", { status: 402 }));
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await expect(rail.preflight({ url: "https://x.com/paid", intent: "t" })).rejects.toThrow(
        RailUnavailableError,
      );
    });

    it("wraps a fetch failure as NetworkError", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await expect(rail.preflight({ url: "https://x.com/paid", intent: "t" })).rejects.toThrow(
        NetworkError,
      );
    });

    it("forwards method, body, and headers to fetch", async () => {
      const fetchMock = vi.fn().mockResolvedValue(make402Response());
      vi.stubGlobal("fetch", fetchMock);
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await rail.preflight({
        url: "https://x.com/paid",
        intent: "t",
        method: "POST",
        body: { hi: "there" },
        headers: { "x-custom": "1" },
      });

      expect(fetchMock).toHaveBeenCalledWith("https://x.com/paid", {
        method: "POST",
        headers: { "x-custom": "1" },
        body: JSON.stringify({ hi: "there" }),
      });
    });
  });

  describe("settle", () => {
    const requirement = {
      amount: 0.01,
      currency: "USDC",
      recipient_wallet: "0xRECIPIENT",
      network: "base-sepolia",
    };

    it("returns a Receipt and data on a successful response", async () => {
      const txHash = "0xeba79551339df19c2b83cf6673201bb3b3e93889c7772b93045bafb54fe9b2f9";
      const wrappedFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ chat: "the completion" }), {
          status: 200,
          headers: { "x-payment-response": makeSettlementHeader(txHash) },
        }),
      );
      mockWrapFetchWithPayment.mockReturnValue(wrappedFetch);
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      const result = await rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {});

      expect(result.data).toEqual({ chat: "the completion" });
      expect(result.receipt.rail).toBe("x402");
      expect(result.receipt.rail_charge_id).toBe(txHash);
      expect(result.receipt.amount).toBe(0.01);
      expect(result.receipt.currency).toBe("USDC");
      expect(result.receipt.recipient_wallet).toBe("0xRECIPIENT");
      expect(result.receipt.recipient_url).toBe("https://x.com/paid");
    });

    it("lazily initialises the signer on first call", async () => {
      // Return a FRESH Response per call: a Response body can only be read
      // once, and real fetch never hands back the same consumed object twice.
      const wrappedFetch = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response("{}", { status: 200, headers: {} })),
        );
      mockWrapFetchWithPayment.mockReturnValue(wrappedFetch);

      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });
      expect(mockCreateSigner).not.toHaveBeenCalled();

      await rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {});
      expect(mockCreateSigner).toHaveBeenCalledTimes(1);
      expect(mockCreateSigner).toHaveBeenCalledWith("base-sepolia", TEST_PK);

      // Second call should reuse the cached signer
      await rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {});
      expect(mockCreateSigner).toHaveBeenCalledTimes(1);
    });

    it("produces a receipt even when the settlement header is absent", async () => {
      mockWrapFetchWithPayment.mockReturnValue(
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      const result = await rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {});
      expect(result.receipt.rail_charge_id).toBeUndefined();
      expect(result.receipt.id).toMatch(/^x402_/);
    });

    it("throws RailUnavailableError on a non-OK response", async () => {
      mockWrapFetchWithPayment.mockReturnValue(
        vi.fn().mockResolvedValue(new Response("server error", { status: 500 })),
      );
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await expect(
        rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {}),
      ).rejects.toThrow(RailUnavailableError);
    });

    it("wraps a thrown settle fetch as RailUnavailableError", async () => {
      mockWrapFetchWithPayment.mockReturnValue(
        vi.fn().mockRejectedValue(new Error("signature rejected")),
      );
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      await expect(
        rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {}),
      ).rejects.toThrow(/signature rejected/);
    });

    it("returns the raw text if the response body is not JSON", async () => {
      mockWrapFetchWithPayment.mockReturnValue(
        vi.fn().mockResolvedValue(
          new Response("just some text", {
            status: 200,
            headers: { "x-payment-response": makeSettlementHeader("0xabc") },
          }),
        ),
      );
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      const result = await rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {});
      // A paid endpoint that returns plain text must not silently lose the
      // purchased data; the caller gets the raw text back.
      expect(result.data).toBe("just some text");
      expect(result.receipt.rail_charge_id).toBe("0xabc");
    });

    it("returns data=undefined when the response body is empty", async () => {
      mockWrapFetchWithPayment.mockReturnValue(
        vi.fn().mockResolvedValue(
          new Response("", {
            status: 200,
            headers: { "x-payment-response": makeSettlementHeader("0xabc") },
          }),
        ),
      );
      const rail = x402Wallet({ privateKey: TEST_PK, chain: "base-sepolia" });

      const result = await rail.settle({ url: "https://x.com/paid", intent: "t" }, requirement, {});
      expect(result.data).toBeUndefined();
    });
  });
});
