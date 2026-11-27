import { describe, expect, it } from "vitest";
import { sanitizeForDisplay } from "../src/display.js";

describe("sanitizeForDisplay", () => {
  it("flattens control characters", () => {
    expect(sanitizeForDisplay("pay\nApprove? [y/N] y\r\x1b[2Kok\ttab")).toBe(
      "pay Approve? [y/N] y  [2Kok tab",
    );
  });
});
