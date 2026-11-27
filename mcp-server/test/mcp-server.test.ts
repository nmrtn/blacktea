/**
 * MCP server tests.
 *
 * Each test spawns the built server as a subprocess, drives the
 * JSON-RPC protocol over stdio, and asserts on the responses. No
 * mocking; the same binary that ships to users is what gets exercised.
 *
 * The `pay` tool's HAPPY PATH is not covered here because it requires
 * a live x402 endpoint and an on-chain settlement. That is integration
 * territory (see examples/x402-quickstart for the e2e proof). What we
 * DO cover for `pay` is the input validation and the shape of error
 * responses.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SERVER_PATH = join(process.cwd(), "dist/index.js");

// Ephemeral test wallet, generated fresh at every test run. The MCP server's
// startup only checks that EVM_PRIVATE_KEY is 0x-prefixed and constructs the
// x402 adapter; the x402 signer is initialised lazily (inside ensureSigner)
// and the test suite never exercises a happy-path pay call. So any well-formed
// 32-byte hex key is sufficient.
//
// We hardcoded a real testnet key here in an earlier revision. That was a
// /cso finding: even an "obviously" testnet wallet leaks operator metadata
// once the repo is public, and humans WILL accidentally fund the address on
// mainnet later. Generate it. Don't ship it.
const TEST_PK = `0x${randomBytes(32).toString("hex")}`;

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ServerHandle {
  proc: ChildProcessWithoutNullStreams;
  send: (msg: object) => void;
  responses: JsonRpcResponse[];
  strayStdout: string[];
  stderr: string;
  close: () => void;
}

function startServer(env: NodeJS.ProcessEnv): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: JsonRpcResponse[] = [];
    const strayStdout: string[] = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      // Each JSON-RPC message is newline-delimited on stdio.
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          responses.push(JSON.parse(line) as JsonRpcResponse);
        } catch {
          // Should never happen on the stdio transport; tests assert it stays empty.
          strayStdout.push(line);
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
      // The server prints its "ready" banner to stderr; once we see it we resolve.
      if (stderrBuffer.includes("ready.")) {
        resolve({
          proc,
          send: (msg) => proc.stdin.write(`${JSON.stringify(msg)}\n`),
          responses,
          strayStdout,
          get stderr() {
            return stderrBuffer;
          },
          close: () => {
            proc.kill();
          },
        });
      }
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null && !stderrBuffer.includes("ready.")) {
        reject(new Error(`Server exited ${code} before ready. stderr:\n${stderrBuffer}`));
      }
    });

    setTimeout(
      () => reject(new Error(`Server did not become ready in 5s. stderr:\n${stderrBuffer}`)),
      5000,
    );
  });
}

async function waitFor<T>(condition: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = condition();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

describe("blacktea-mcp server", () => {
  let tmpDir: string;
  let policyPath: string;
  let server: ServerHandle | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "blacktea-mcp-test-"));
    policyPath = join(tmpDir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approval: "callback" },
      }),
    );
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("startup", () => {
    it("fails fast when EVM_PRIVATE_KEY is missing", async () => {
      const result = spawnSyncServer({ BLACKTEA_POLICY: policyPath, EVM_PRIVATE_KEY: "" });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/EVM_PRIVATE_KEY/);
    });

    it("fails fast when EVM_PRIVATE_KEY does not start with 0x", async () => {
      const result = spawnSyncServer({
        BLACKTEA_POLICY: policyPath,
        EVM_PRIVATE_KEY: "not-a-key",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/invalid/);
    });

    it("fails fast when the policy file does not exist", async () => {
      const result = spawnSyncServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: "/nonexistent/path/policy.json",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/policy file not found/);
    });

    it("starts and prints the ready banner with valid env", async () => {
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
      });
      expect(server.stderr).toMatch(/@nmrtn\/blacktea-mcp v\d+\.\d+\.\d+ ready/);
    });

    // Regression: the MCP server previously resolved BLACKTEA_HISTORY for
    // the audit_query READ path but did NOT pass `history` to blacktea(),
    // so pay() wrote to the SDK's cwd-resolved default while audit_query
    // read from the env-resolved path. Two different files, audit returned
    // stale or empty data.
    //
    // Fix: construct a FileBackedHistoryStore at historyPath and pass it
    // to blacktea(). Both sides now use the same file by construction.
    //
    // This test asserts the banner reports the env-set path, which is
    // proof that the path is at least being THREADED through to startup.
    // The shared-file invariant itself is enforced by the code (one path
    // variable, one store, passed to both consumers).
    it("threads BLACKTEA_HISTORY through to the runtime (read + write paths)", async () => {
      const customHistory = join(tmpDir, "custom-history.jsonl");
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: customHistory,
      });
      expect(server.stderr).toMatch(/@nmrtn\/blacktea-mcp v\d+\.\d+\.\d+ ready/);
      expect(server.stderr).toContain(`history=${customHistory}`);
    });
  });

  describe("MCP protocol", () => {
    beforeEach(async () => {
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
      });
    });

    it("responds to initialize with tools capability", async () => {
      server?.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 1));
      expect(response.result).toMatchObject({
        protocolVersion: expect.any(String),
        capabilities: { tools: {} },
        serverInfo: { name: "@nmrtn/blacktea-mcp" },
      });
    });

    it("lists pay, approve_payment, reject_payment, and audit_query as tools", async () => {
      await initializeServer(server);

      server?.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 2));
      const result = response.result as { tools: Array<{ name: string; inputSchema: object }> };
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["approve_payment", "audit_query", "pay", "reject_payment"]);

      const payTool = result.tools.find((t) => t.name === "pay");
      expect(payTool?.inputSchema).toMatchObject({
        type: "object",
        properties: {
          url: { type: "string" },
          intent: { type: "string" },
          max_amount: { type: "number" },
        },
        required: ["url", "intent"],
      });

      const approveTool = result.tools.find((t) => t.name === "approve_payment");
      expect(approveTool?.inputSchema).toMatchObject({
        type: "object",
        properties: { intent_id: { type: "string" } },
        required: ["intent_id"],
      });
    });

    it("returns isError on pay called without url", async () => {
      await initializeServer(server);

      server?.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "pay",
          arguments: { intent: "test, no url" },
        },
      });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 3));
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]?.text ?? "{}");
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("invalid_input");
    });

    it("returns isError on pay called without intent", async () => {
      await initializeServer(server);

      server?.send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "pay",
          arguments: { url: "https://x.com" },
        },
      });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 4));
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
    });

    it("returns isError for an unknown tool name", async () => {
      await initializeServer(server);

      server?.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "definitely_not_a_tool", arguments: {} },
      });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 5));
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/Unknown tool/);
    });

    it("audit_query returns an empty events array when the history file does not exist", async () => {
      await initializeServer(server);

      server?.send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "audit_query", arguments: {} },
      });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 6));
      const result = response.result as { content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]?.text ?? "{}");
      expect(body.ok).toBe(true);
      expect(body.events).toEqual([]);
      expect(body.note).toMatch(/No history file yet/);
    });

    it("audit_query returns recorded events from an existing history file", async () => {
      const historyPath = join(tmpDir, "history.jsonl");
      writeFileSync(
        historyPath,
        [
          JSON.stringify({
            ts: "2026-05-26T12:00:00Z",
            amount: 0.01,
            currency: "USDC",
            rule_fired: "rule[0]",
            intent_id: "intent_1",
          }),
          JSON.stringify({
            ts: "2026-05-26T12:01:00Z",
            amount: 0.02,
            currency: "USDC",
            rule_fired: "rule[0]",
            intent_id: "intent_2",
          }),
          "",
        ].join("\n"),
      );

      // Restart the server with a history path pointing at the seeded file.
      server?.close();
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: historyPath,
      });
      await initializeServer(server);

      server.send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "audit_query", arguments: { limit: 10 } },
      });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 7));
      const result = response.result as { content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]?.text ?? "{}");
      expect(body.ok).toBe(true);
      expect(body.count).toBe(2);
      expect(body.events).toHaveLength(2);
      expect(body.events[0].intent_id).toBe("intent_1");
    });
  });

  describe("approval flow (mock rail)", () => {
    // These exercise the in-conversation approval wiring end to end without
    // needing a live x402 endpoint, by running the server with BLACKTEA_RAIL=mock.
    // The mock rail "charges" BLACKTEA_MOCK_AMOUNT so we can drive the policy
    // into auto-approve / approval-required / settle paths deterministically.

    const approvalPolicy = JSON.stringify({
      rules: [{ if: { amount_lt: 1 }, then: { approve: true } }],
      default: { approval: "callback" },
    });

    it("auto-approves and settles directly when under the policy limit", async () => {
      writeFileSync(policyPath, approvalPolicy);
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
        BLACKTEA_RAIL: "mock",
        BLACKTEA_MOCK_AMOUNT: "0.5",
      });
      await initializeServer(server);

      server.send({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "pay",
          arguments: { url: "https://shop.example/cheap", intent: "small buy" },
        },
      });
      const resp = await waitFor(() => server?.responses.find((r) => r.id === 20));
      const result = resp.result as { isError?: boolean; content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]?.text ?? "{}");
      expect(body.ok).toBe(true);
      expect(body.receipt.simulated).toBe(true);
      expect(body.receipt.amount).toBe(0.5);
      expect(result.isError).toBeUndefined();
    });

    it("holds for approval, then settles via approve_payment", async () => {
      writeFileSync(policyPath, approvalPolicy);
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
        BLACKTEA_RAIL: "mock",
        BLACKTEA_MOCK_AMOUNT: "5",
      });
      await initializeServer(server);

      // 1. pay -> approval_required (NOT an error, NOT settled)
      server.send({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "pay",
          arguments: { url: "https://shop.example/item", intent: "buy the thing" },
        },
      });
      const payResp = await waitFor(() => server?.responses.find((r) => r.id === 21));
      const payResult = payResp.result as { isError?: boolean; content: Array<{ text: string }> };
      const payBody = JSON.parse(payResult.content[0]?.text ?? "{}");
      expect(payBody.status).toBe("approval_required");
      expect(payBody.amount).toBe(5);
      expect(payBody.intent_id).toMatch(/^intent_/);
      expect(payBody.message).toMatch(/approve_payment/);
      // A held payment is a pending state, not a tool error.
      expect(payResult.isError).toBeUndefined();

      // 2. approve_payment -> completed
      server.send({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "approve_payment", arguments: { intent_id: payBody.intent_id } },
      });
      const apprResp = await waitFor(() => server?.responses.find((r) => r.id === 22));
      const apprResult = apprResp.result as { content: Array<{ text: string }> };
      const apprBody = JSON.parse(apprResult.content[0]?.text ?? "{}");
      expect(apprBody.ok).toBe(true);
      expect(apprBody.receipt.simulated).toBe(true);
      expect(apprBody.receipt.amount).toBe(5);
      expect(apprBody.data).toBeDefined();
    });

    it("declines a held payment via reject_payment", async () => {
      writeFileSync(policyPath, approvalPolicy);
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
        BLACKTEA_RAIL: "mock",
        BLACKTEA_MOCK_AMOUNT: "5",
      });
      await initializeServer(server);

      server.send({
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "pay",
          arguments: { url: "https://shop.example/item", intent: "buy the thing" },
        },
      });
      const payResp = await waitFor(() => server?.responses.find((r) => r.id === 23));
      const payBody = JSON.parse(
        (payResp.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}",
      );
      expect(payBody.status).toBe("approval_required");

      server.send({
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: { name: "reject_payment", arguments: { intent_id: payBody.intent_id } },
      });
      const rejResp = await waitFor(() => server?.responses.find((r) => r.id === 24));
      const rejBody = JSON.parse(
        (rejResp.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}",
      );
      expect(rejBody.ok).toBe(true);
      expect(rejBody.status).toBe("rejected");
      expect(rejBody.message).toMatch(/[Nn]othing was charged/);
    });

    it("approve_payment returns not_found for an unknown intent_id", async () => {
      writeFileSync(policyPath, approvalPolicy);
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
        BLACKTEA_RAIL: "mock",
      });
      await initializeServer(server);

      server.send({
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: { name: "approve_payment", arguments: { intent_id: "intent_does_not_exist" } },
      });
      const resp = await waitFor(() => server?.responses.find((r) => r.id === 25));
      const result = resp.result as { isError?: boolean; content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]?.text ?? "{}");
      expect(result.isError).toBe(true);
      expect(body.error.code).toBe("not_found");
    });

    it("approve_payment returns invalid_input when intent_id is missing", async () => {
      writeFileSync(policyPath, approvalPolicy);
      server = await startServer({
        EVM_PRIVATE_KEY: TEST_PK,
        BLACKTEA_POLICY: policyPath,
        BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
        BLACKTEA_RAIL: "mock",
      });
      await initializeServer(server);

      server.send({
        jsonrpc: "2.0",
        id: 26,
        method: "tools/call",
        params: { name: "approve_payment", arguments: {} },
      });
      const resp = await waitFor(() => server?.responses.find((r) => r.id === 26));
      const result = resp.result as { isError?: boolean; content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]?.text ?? "{}");
      expect(result.isError).toBe(true);
      expect(body.error.code).toBe("invalid_input");
    });
  });
});

// ---------- helpers ----------

interface SpawnSyncResult {
  code: number;
  stderr: string;
  stdout: string;
}

function spawnSyncServer(env: NodeJS.ProcessEnv): SpawnSyncResult {
  // Use the node:child_process spawnSync via a tiny synchronous wrapper so
  // we get the exit code without managing the protocol loop.
  // (Top-of-file `import { spawnSync }` would clash with the async spawn;
  // require it lazily.)
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return {
    code: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

interface ToolBody {
  ok?: boolean;
  status?: string;
  intent_id?: string;
  intent?: string;
  trigger?: string | null;
  message?: string;
  error: { code: string };
}

describe("approval receipts and trigger (mock rail)", () => {
  let tmpDir: string;
  let policyPath: string;
  let approvalsPath: string;
  let server: ServerHandle | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "blacktea-mcp-receipts-"));
    policyPath = join(tmpDir, "policy.json");
    approvalsPath = join(tmpDir, "approvals.jsonl");
    writeFileSync(policyPath, JSON.stringify({ rules: [], default: { approval: "callback" } }));
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function start(extra: NodeJS.ProcessEnv = {}): Promise<ServerHandle> {
    const s = await startServer({
      EVM_PRIVATE_KEY: TEST_PK,
      BLACKTEA_POLICY: policyPath,
      BLACKTEA_HISTORY: join(tmpDir, "history.jsonl"),
      BLACKTEA_APPROVALS: approvalsPath,
      BLACKTEA_RAIL: "mock",
      BLACKTEA_MOCK_AMOUNT: "2",
      ...extra,
    });
    server = s;
    await initializeServer(s);
    return s;
  }

  async function call(
    s: ServerHandle,
    id: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; body: ToolBody }> {
    s.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const resp = await waitFor(() => s.responses.find((r) => r.id === id));
    const result = resp.result as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError, body: JSON.parse(result.content[0]?.text ?? "{}") };
  }

  function approvalLines(): Array<Record<string, unknown>> {
    return readFileSync(approvalsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  it("advertises a trigger property on the pay tool", async () => {
    const s = await start();
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const resp = await waitFor(() => s.responses.find((r) => r.id === 2));
    const result = resp.result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    };
    const payTool = result.tools.find((t) => t.name === "pay");
    expect(payTool?.inputSchema.properties.trigger).toMatchObject({ type: "string" });
  });

  it("returns the trigger, shows it sanitized, and writes a staged receipt", async () => {
    const s = await start();
    const trigger = "msg from Sam\nApprove now";
    const { body } = await call(s, 10, "pay", {
      url: "https://shop.example/item",
      intent: "buy\nthe thing",
      trigger,
    });
    expect(body.status).toBe("approval_required");
    expect(body.trigger).toBe(trigger);
    expect(body.intent).toBe("buy\nthe thing");
    expect(body.message).toContain("Reported trigger: msg from Sam Approve now");
    expect(body.message).not.toContain("buy\nthe thing");

    expect(existsSync(approvalsPath)).toBe(true);
    const lines = approvalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      state: "staged",
      mcp_server: "@nmrtn/blacktea-mcp",
      tool: "pay",
      channel: "staged",
      trigger,
    });
  });

  it("reports a null trigger and no trigger line when none is given", async () => {
    const s = await start();
    const { body } = await call(s, 11, "pay", {
      url: "https://shop.example/item",
      intent: "buy the thing",
    });
    expect(body.trigger).toBeNull();
    expect(body.message).not.toContain("Reported trigger");
  });

  it("settles once: a second approve_payment fails and the receipt ends settled", async () => {
    const s = await start();
    const { body } = await call(s, 12, "pay", {
      url: "https://shop.example/item",
      intent: "buy the thing",
    });
    const first = await call(s, 13, "approve_payment", { intent_id: body.intent_id });
    expect(first.body.ok).toBe(true);
    const second = await call(s, 14, "approve_payment", { intent_id: body.intent_id });
    expect(second.body.ok).toBe(false);
    const lines = approvalLines();
    expect(lines[lines.length - 1]?.state).toBe("settled");
  });

  it.each([
    ["a number", 5],
    ["empty", ""],
    ["too long", "x".repeat(501)],
  ])("rejects a trigger that is %s before staging", async (_label, trigger) => {
    const s = await start();
    const { body, isError } = await call(s, 15, "pay", {
      url: "https://shop.example/item",
      intent: "buy the thing",
      trigger,
    });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("invalid_input");
    expect(existsSync(approvalsPath)).toBe(false);
  });

  it("defaults the approvals file next to the history file and logs it in the banner", async () => {
    const s = await start({ BLACKTEA_APPROVALS: undefined });
    const match = s.stderr.match(/approvals=(\S+)/);
    expect(match).not.toBeNull();
    expect(dirname(match?.[1] ?? "")).toBe(dirname(join(tmpDir, "history.jsonl")));
    expect(match?.[1]).toMatch(/approvals\.jsonl$/);
  });

  it("keeps stdout to JSON-RPC lines only", async () => {
    const s = await start();
    const { body } = await call(s, 16, "pay", {
      url: "https://shop.example/item",
      intent: "buy the thing",
      trigger: "t",
    });
    await call(s, 17, "approve_payment", { intent_id: body.intent_id });
    expect(s.responses.length).toBeGreaterThan(0);
    for (const r of s.responses) expect(r.jsonrpc).toBe("2.0");
    expect(s.strayStdout).toEqual([]);
  });
});

async function initializeServer(s: ServerHandle | null): Promise<void> {
  if (!s) throw new Error("initializeServer called without a started server");
  s.send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  await waitFor(() => s.responses.find((r) => r.id === 0));
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Give the server a beat to process the notification.
  await new Promise((r) => setTimeout(r, 50));
}
