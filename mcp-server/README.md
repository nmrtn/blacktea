# @nmrtn/blacktea-mcp

MCP server exposing [blacktea](https://github.com/nmrtn/blacktea)'s `pay`
tool to Claude Desktop, Cursor, and any other MCP-aware client. Drop one
config block and your assistant gains a typed `pay` tool with full
policy + audit enforcement.

## Tools exposed

| Tool | What it does |
|---|---|
| `pay` | Make a paid HTTP request via x402. Library applies your policy before signing; large or unusual payments may require approval. Returns the response body and a payment receipt. |
| `audit_query` | Read recent payment events from the audit log. Useful when the assistant needs to explain what was paid for or how much was spent today. |

## Install

You do not install it permanently. The MCP client spawns it on demand
via `npx`. Configure once per client.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Add
under `mcpServers`:

```json
{
  "mcpServers": {
    "blacktea": {
      "command": "npx",
      "args": ["-y", "@nmrtn/blacktea-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0xYourBaseSepoliaPrivateKey",
        "BLACKTEA_POLICY": "/absolute/path/to/policy.json",
        "BLACKTEA_CHAIN": "base-sepolia"
      }
    }
  }
}
```

Restart Claude Desktop. The new tool appears in the tool list. Ask
"use the pay tool to fetch \<some x402 URL\>" and watch.

### Cursor

In Cursor settings, add an MCP server with the same shape: `npx -y
@nmrtn/blacktea-mcp`, and the same env vars.

### Cline / Continue / other MCP-aware clients

Same pattern. The MCP standard is consistent across clients.

## Configuration env vars

| Env var | Required | Default | What |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | yes | none | 0x-prefixed wallet private key. Holds USDC for payments. |
| `BLACKTEA_POLICY` | no | `./policy.json` | Path to the policy file. Use an absolute path; relative paths resolve from wherever the MCP client spawns the server. |
| `BLACKTEA_CHAIN` | no | `base-sepolia` | EVM chain identifier passed to x402. Use `base` for mainnet. |
| `BLACKTEA_HISTORY` | no | `./.blacktea/history.jsonl` | Path to the JSONL audit log. |

## What a policy file looks like

See [docs/policy-cookbook.md](https://github.com/nmrtn/blacktea/blob/main/docs/policy-cookbook.md)
in the main repo for the full DSL reference. Quick example:

```json
{
  "rules": [
    { "if": { "amount_gte": 5 },   "then": { "reject": "absolute_cap" } },
    { "if": { "amount_lt": 0.1 },  "then": { "approve": true } },
    { "if": { "amount_gte": 0.1 }, "then": { "approval": "console" } }
  ],
  "default": { "approval": "console" }
}
```

Save it somewhere stable (e.g. `~/.config/blacktea/policy.json`) and
point `BLACKTEA_POLICY` at it.

## What this does NOT do

- It does not hold your private key for you. The key stays on your
  machine; we never see it.
- It does not include a UI for approval prompts. v0.0.1 uses the
  `console` channel which prompts on stderr; for Slack/SMS/etc, the
  caller of the underlying library can supply an `onApprovalNeeded`
  callback (SDK path, not yet exposed through MCP).

## See also

- Main repo: [github.com/nmrtn/blacktea](https://github.com/nmrtn/blacktea)
- Library: [`npm install @nmrtn/blacktea`](https://www.npmjs.com/package/@nmrtn/blacktea)
- Policy cookbook: [docs/policy-cookbook.md](https://github.com/nmrtn/blacktea/blob/main/docs/policy-cookbook.md)

## License

MIT.
