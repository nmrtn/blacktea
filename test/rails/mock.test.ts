/**
 * Tests for the public mock rail adapter.
 *
 * The mock rail is a real product surface, not just test infrastructure.
 * It's what first-time users hit when they want to try blacktea without
 * setting up x402, a wallet, and USDC. Treat it like any other rail.
 */

import { describe, expect, it } from "vitest";
import { mockWallet } from "../../src/rails/mock.js";

describe("mockWallet", () => {
  it("reports name 'mock' by default and is configurable", () => {
    expect(mockWallet().name).toBe("mock");
    expect(mockWallet({ name: "sandbox-eur" }).name).toBe("sandbox-eur");
  });

  it("supports any url by default", () => {
    const rail = mockWallet();
    expect(rail.supports({ url: "https://example.com", intent: "test" })).toBe(true);
    expect(rail.supports({ url: "https://different.example/x", intent: "test" })).toBe(true);
  });

  it("supports() returns false when unsupported: true", () => {
    const rail = mockWallet({ unsupported: true });
    expect(rail.supports({ url: "https://example.com", intent: "test" })).toBe(false);
  });

  it("preflight returns the configured amount and currency", async () => {
    const rail = mockWallet({ amount: 1.5, currency: "EUR", network: "mock-eur" });
    const req = await rail.preflight({ url: "https://example.com", intent: "test" });
    expect(req.amount).toBe(1.5);
    expect(req.currency).toBe("EUR");
    expect(req.network).toBe("mock-eur");
    expect(req.recipient_wallet).toMatch(/^0x/);
  });

  it("preflight returns defaults when no config is given", async () => {
    const rail = mockWallet();
    const req = await rail.preflight({ url: "https://example.com", intent: "test" });
    expect(req.amount).toBe(0.01);
    expect(req.currency).toBe("USDC");
    expect(req.network).toBe("mock");
  });

  it("settle returns a synthetic receipt with simulated: true", async () => {
    const rail = mockWallet({ amount: 0.5 });
    const req = await rail.preflight({ url: "https://example.com/api", intent: "test" });
    const settled = await rail.settle({ url: "https://example.com/api", intent: "test" }, req, {});
    expect(settled.receipt.simulated).toBe(true);
    expect(settled.receipt.rail).toBe("mock");
    expect(settled.receipt.amount).toBe(0.5);
    expect(settled.receipt.currency).toBe("USDC");
    expect(settled.receipt.recipient_url).toBe("https://example.com/api");
    expect(settled.receipt.id).toMatch(/^mock_\d+$/);
    expect(settled.receipt.rail_charge_id).toMatch(/^mock_charge_\d+$/);
  });

  it("settle returns the configured responseData as data", async () => {
    const rail = mockWallet({
      responseData: { custom: true, value: 42 },
    });
    const req = await rail.preflight({ url: "https://example.com", intent: "test" });
    const settled = await rail.settle({ url: "https://example.com", intent: "test" }, req, {});
    expect(settled.data).toEqual({ custom: true, value: 42 });
  });

  it("default responseData has a message and timestamp", async () => {
    const rail = mockWallet();
    const req = await rail.preflight({ url: "https://example.com", intent: "test" });
    const settled = await rail.settle({ url: "https://example.com", intent: "test" }, req, {});
    const data = settled.data as { message: string; timestamp: string };
    expect(data.message).toContain("Hello from the mock rail");
    expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not make any network call (settle is fast and offline)", async () => {
    // No setup needed beyond instantiating mockWallet - if it tried to fetch
    // anything in preflight/settle, this test would either hang or fail in
    // a sandboxed CI environment with no network access.
    const rail = mockWallet({ amount: 0.1 });
    const start = Date.now();
    const req = await rail.preflight({ url: "https://nonexistent.invalid", intent: "test" });
    const settled = await rail.settle(
      { url: "https://nonexistent.invalid", intent: "test" },
      req,
      {},
    );
    const elapsed = Date.now() - start;
    expect(settled.receipt.simulated).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });
});
