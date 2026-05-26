/**
 * Schema validation tests.
 *
 * The ten cookbook examples in test/fixtures/cookbook/ must all pass.
 * If you add a new operator or change the schema, add a fixture here
 * that exercises it and update docs/policy-cookbook.md to match.
 *
 * The invalid fixtures in test/fixtures/invalid/ document mistakes that
 * the schema should catch at load time. Each one names the mistake.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PolicySchema } from "../../src/policy/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("PolicySchema", () => {
  describe("valid cookbook examples", () => {
    const cookbookDir = join(FIXTURES_DIR, "cookbook");
    const files = readdirSync(cookbookDir).filter((f) => f.endsWith(".json"));

    if (files.length === 0) {
      throw new Error(`No cookbook fixtures found at ${cookbookDir}`);
    }

    for (const file of files) {
      it(`validates ${file}`, () => {
        const policy = loadJson(join(cookbookDir, file));
        const result = PolicySchema.safeParse(policy);
        if (!result.success) {
          // Surface the actual error so a contributor can see what is wrong.
          throw new Error(
            `Expected ${file} to be valid. Errors:\n${JSON.stringify(result.error.format(), null, 2)}`,
          );
        }
        expect(result.success).toBe(true);
      });
    }
  });

  describe("invalid fixtures", () => {
    const invalidDir = join(FIXTURES_DIR, "invalid");
    const files = readdirSync(invalidDir).filter((f) => f.endsWith(".json"));

    if (files.length === 0) {
      throw new Error(`No invalid fixtures found at ${invalidDir}`);
    }

    for (const file of files) {
      it(`rejects ${file}`, () => {
        const policy = loadJson(join(invalidDir, file));
        const result = PolicySchema.safeParse(policy);
        expect(result.success).toBe(false);
      });
    }
  });

  describe("specific shape checks", () => {
    it("rejects an empty rules array policy that omits default", () => {
      const result = PolicySchema.safeParse({ rules: [] });
      expect(result.success).toBe(false);
    });

    it("accepts an empty rules array when default is present", () => {
      const result = PolicySchema.safeParse({ rules: [], default: { approve: true } });
      expect(result.success).toBe(true);
    });

    it("accepts an optional time_zone field", () => {
      const result = PolicySchema.safeParse({
        time_zone: "America/New_York",
        rules: [],
        default: { approve: true },
      });
      expect(result.success).toBe(true);
    });

    it("rejects extra top-level keys", () => {
      const result = PolicySchema.safeParse({
        rules: [],
        default: { approve: true },
        unexpected_field: "nope",
      });
      expect(result.success).toBe(false);
    });

    it("rejects approve: false (use reject instead)", () => {
      const result = PolicySchema.safeParse({
        rules: [{ if: { amount_lt: 10 }, then: { approve: false } }],
        default: { approve: true },
      });
      expect(result.success).toBe(false);
    });

    it("accepts the structured approval form with timeout_seconds", () => {
      const result = PolicySchema.safeParse({
        rules: [
          {
            if: { amount_gte: 100 },
            then: { approval: { via: "callback", timeout_seconds: 600 } },
          },
        ],
        default: { approve: true },
      });
      expect(result.success).toBe(true);
    });

    it("accepts nested all/any/not combinators", () => {
      const result = PolicySchema.safeParse({
        rules: [
          {
            if: {
              all: [
                { amount_gte: 50 },
                { any: [{ wallet_in: ["0xabc"] }, { url_starts_with: "https://x.com" }] },
                { not: { intent_eq: "test" } },
              ],
            },
            then: { reject: "complex_match" },
          },
        ],
        default: { approve: true },
      });
      expect(result.success).toBe(true);
    });
  });
});
