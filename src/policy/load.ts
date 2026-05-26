/**
 * Policy loader.
 *
 * Two forms accepted:
 *   loadPolicy(policyObject)  - validates against the Zod schema
 *   loadPolicy(pathToJson)    - reads the file, parses, validates
 *
 * Future: walk the parsed policy and resolve file-path-form wallet_in
 * references into inline arrays. For now, the evaluator throws a clear
 * error when it encounters an unresolved file path. Customers using the
 * file-path form should call resolvePolicyFilePaths() before evaluation
 * (not implemented yet).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PolicyParseError } from "../errors.js";
import { type Policy, PolicySchema } from "./schema.js";

export function loadPolicy(input: Policy | string): Policy {
  if (typeof input === "string") {
    return loadPolicyFromFile(input);
  }
  return validatePolicy(input);
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
  return validatePolicy(json);
}

function validatePolicy(candidate: unknown): Policy {
  const parsed = PolicySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PolicyParseError("Policy failed schema validation", parsed.error.format());
  }
  return parsed.data;
}
