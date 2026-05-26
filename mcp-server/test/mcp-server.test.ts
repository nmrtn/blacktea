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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          // Ignore non-JSON noise; should not happen on stdio transport.
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

    it("lists pay and audit_query as tools", async () => {
      await initializeServer(server);

      server?.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

      const response = await waitFor(() => server?.responses.find((r) => r.id === 2));
      const result = response.result as { tools: Array<{ name: string; inputSchema: object }> };
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["audit_query", "pay"]);

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
