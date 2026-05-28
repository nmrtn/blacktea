# packaging/

Marketplace listing artifacts for blacktea. These are the source-of-truth
copies; each gets submitted to an external registry. Kept here so the listings
are versioned alongside the code.

## What's here

| Path | Target marketplace | Format | Status |
|---|---|---|---|
| `blacktea/SKILL.md` | ClawHub (OpenClaw) + Hermes skills taps | agentskills.io, dual `metadata.openclaw` + `metadata.hermes` | Published to ClawHub |
| `hermeshub/blacktea/SKILL.md` | HermesHub registry | HermesHub house style (`metadata.author`, `metadata.hermes.requires_tools`, `category`, `compatibility`) | PR to `amanning3390/hermeshub` |
| `hermes-mcp-catalog/blacktea/manifest.yaml` | Nous official MCP catalog | `manifest_version: 1` (schema from `optional-mcps/{n8n,linear}`) | PR to `NousResearch/hermes-agent` |

There are two SKILL.md variants on purpose: ClawHub and HermesHub both build on
the agentskills.io standard but use slightly different frontmatter conventions.
`blacktea/SKILL.md` carries both platforms' metadata blocks (it published clean
to ClawHub); `hermeshub/blacktea/SKILL.md` matches HermesHub's observed house
style so the PR reads native there.

## How each gets submitted

### ClawHub (OpenClaw) — done

```bash
npm i -g clawhub
clawhub login            # browser OAuth
clawhub skill publish packaging/blacktea --slug blacktea --name "blacktea" \
  --version 0.1.0 --changelog "..." --tags latest
```

Appears in `openclaw skills search` and on clawhub.ai. Install:
`openclaw skills install blacktea`.

### Nous MCP catalog (Hermes) — PR

Copy `hermes-mcp-catalog/blacktea/manifest.yaml` to
`optional-mcps/blacktea/manifest.yaml` in a fork of `NousResearch/hermes-agent`
and open a PR. Nous staff review and merge. Once merged:
`hermes mcp install blacktea`.

### HermesHub (Hermes) — PR

Copy `hermeshub/blacktea/SKILL.md` to `skills/blacktea/SKILL.md` in a fork of
`amanning3390/hermeshub` and open a PR. An automated scanner runs on the PR.
Install: `hermes skills install github:amanning3390/hermeshub/skills/blacktea`.

### awesome-hermes-agent — PR

Add one entry under "Skills & Plugins → Community Skills" in
`0xNyk/awesome-hermes-agent`.

## Keeping these in sync

When the published version bumps, update the `version` in both SKILL.md files
and re-publish to ClawHub / open update PRs. The Nous manifest uses
`npx -y @nmrtn/blacktea-mcp` (no version pin), so it always resolves the latest
published package.
