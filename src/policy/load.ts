/**
 * Policy loader.
 *
 * Two forms accepted:
 *   loadPolicy(policyObject)  - validates against the Zod schema
 *   loadPolicy(pathToJson)    - reads the file, parses, validates
 *
 * After validation, any `wallet_in` operator whose value is a file path
 * (a string instead of an inline array) is resolved: the file is read, one
 * wallet per line, `#` comments and blank lines ignored, and the result is
 * spliced back in as an inline array. For file-loaded policies the path is
 * resolved relative to the policy file's directory; for object-form policies
 * it is resolved relative to the current working directory. The evaluator
 * only ever sees inline arrays.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PolicyParseError } from "../errors.js";
import { type Policy, type PolicyCondition, PolicySchema } from "./schema.js";

export function loadPolicy(input: Policy | string): Policy {
  if (typeof input === "string") {
    return loadPolicyFromFile(input);
  }
  return resolveWalletInPaths(validatePolicy(input), process.cwd());
}

function loadPolicyFromFile(path: string): Policy {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new PolicyParseError(`Policy file not found: ${abs}`);
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch (err) {
    throw new PolicyParseError(`Could not read policy file ${abs}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new PolicyParseError(
      `Policy file ${abs} contains invalid JSON: ${(err as Error).message}`,
    );
  }
  // Resolve wallet_in file paths relative to the policy file's directory, so
  // `"./blocklist.txt"` means "next to policy.json", not "next to wherever the
  // process happened to start".
  return resolveWalletInPaths(validatePolicy(json), dirname(abs));
}

function validatePolicy(candidate: unknown): Policy {
  const parsed = PolicySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PolicyParseError("Policy failed schema validation", parsed.error.format());
  }
  return parsed.data;
}

/**
 * Walk every rule's condition tree and replace file-path-form `wallet_in`
 * values with the inline array read from the file. Mutates the policy in
 * place (we own the freshly-parsed object) and returns it for chaining.
 */
function resolveWalletInPaths(policy: Policy, baseDir: string): Policy {
  for (const rule of policy.rules) {
    resolveConditionWalletIn(rule.if, baseDir);
  }
  return policy;
}

function resolveConditionWalletIn(condition: PolicyCondition, baseDir: string): void {
  if ("wallet_in" in condition && typeof condition.wallet_in === "string") {
    condition.wallet_in = readWalletList(condition.wallet_in, baseDir);
    return;
  }
  if ("all" in condition) {
    for (const sub of condition.all) resolveConditionWalletIn(sub, baseDir);
    return;
  }
  if ("any" in condition) {
    for (const sub of condition.any) resolveConditionWalletIn(sub, baseDir);
    return;
  }
  if ("not" in condition) {
    resolveConditionWalletIn(condition.not, baseDir);
  }
}

function readWalletList(filePath: string, baseDir: string): string[] {
  const abs = resolve(baseDir, filePath);
  if (!existsSync(abs)) {
    throw new PolicyParseError(
      `wallet_in references a file that does not exist: ${abs}. Create the file (one wallet per line) or use an inline array.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch (err) {
    throw new PolicyParseError(`Could not read wallet_in file ${abs}: ${(err as Error).message}`);
  }
  // One entry per line. Strip `#` comments (full-line and inline) and blanks.
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}
