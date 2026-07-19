# AI-DLC on opencode

`dist/opencode/` is one of the framework's harness distributions, for the
open-source **opencode** harness (opencode.ai). One deterministic core, many
harnesses: the engine, state machine, audit log, graph, swarm referee, and
learnings gate are byte-identical across every distribution — only the shell
differs. The tree is **generated** from `core/` + `harness/opencode/` by
`bun scripts/package.ts opencode`; never hand-edit it (the drift guard fails CI).

## Layout: two dot-dirs, on purpose

opencode auto-imports every `*.ts` under `.opencode/tools/` and
`.opencode/tool/` as custom tool definitions, and importing a CLI-style engine
script (top-level dispatch, `process.exit`) crashes the session
(live-reproduced on opencode 1.17.18). So this distribution splits:

- **`.aidlc/`** — the AIDLC engine tree (tools, hooks, skills, agents,
  knowledge, scopes, sensors, aidlc-common). opencode never scans it; the
  shipped `opencode.json` registers `skills.paths: [".aidlc/skills"]` so the
  orchestrator skill and every generated runner are discovered there.
- **`.opencode/`** — only natively-consumed surfaces: the 14 persona
  subagents (`agents/*.md`, `mode: subagent`), the `/aidlc` command
  (`command/aidlc.md`), and the hook-adapter plugin
  (`plugin/aidlc-opencode-adapter.ts`, auto-discovered by opencode).

## Prerequisites

- **opencode ≥ 1.17** — the plugin hook surface this install relies on
  (`tool.execute.before`, `tool.execute.after`, `chat.message`, `session.idle`,
  `experimental.session.compacting`) and project-local skill/agent discovery.
  Check with `opencode --version`.
- The self-contained **`aidlc` command** installed below. Tools and hooks route
  through that binary; Bun and Node.js are not runtime prerequisites.
- **A model provider** — the shipped project `opencode.json` pins no session
  model; your global opencode config supplies it. Tiered personas pin
  `amazon-bedrock/global.anthropic.claude-sonnet-4-6` — override per agent in
  the project `opencode.json` if your provider differs.

## Install

1. Install AI-DLC and initialize the project:

   ```bash
   curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
     | sh -s -- --harness opencode
   cd your-project
   aidlc init
   ```

   `opencode.json` carries three load-bearing blocks: `skills.paths` (skill
   discovery from `.aidlc/skills`), `instructions` (the method-tree include —
   `/aidlc space <name>` re-points it), and permission rules for AIDLC bash
   commands plus edits under `.aidlc/tools/` and `.aidlc/hooks/`. Init merges
   these entries into an existing `opencode.json` or `opencode.jsonc`.
   The adapter enforces the permission boundary: `aidlc` must be invoked as one
   direct command with no
   chaining, redirection, expansion, or command substitution. Engine-code edits
   prompt for approval.

2. For a source checkout, initialize from the committed projection after
   installing a matching binary:

   ```bash
   aidlc init --project-dir your-project --from "$PWD/dist/opencode" --harness opencode
   ```

3. Start opencode in the project and run `/aidlc --doctor`, then `/aidlc`
   followed by what you want to build.

## What's different on this harness

- **Questions render as numbered prose options** (no structured-question
  widget); the questions FILE with `[Answer]:` tags remains the source of
  truth.
- **Hooks ride the adapter plugin.** opencode has no hooks.json/settings hook
  registry; `.opencode/plugin/aidlc-opencode-adapter.ts` maps opencode's
  plugin hook moments onto the core hook bodies in `.aidlc/hooks/` through
  `aidlc hook`: reviewer read-scope and the AIDLC bash boundary before tool
  execution; audit + sensors on write/edit/apply_patch; runtime-compile on
  bash; statusline sync on todowrite; subagent logging on task; presence
  minting on each human turn; state validation before compaction.
- **Forwarding-loop enforcement is advisory.** The Stop seam is the
  `session.idle` event — reactive, not blocking. When the core stop hook
  answers `block`, the plugin re-engages the loop by injecting a nudge prompt
  (marked with a sentinel so it never mints human presence). A chatting or
  pausing human is released by the hook's interactive cap.
- **Personas are native subagents** (`mode: subagent`); the conductor adopts
  them inline for most stages and delegates via the `task` tool for the two
  subagent stages (2.1 reverse-engineering, 3.5 code-generation). Their native
  permission map denies `task`, so delegated agents cannot delegate again.
  Plugin composition emits the same `.opencode/agents/` twin for plugin personas.
- **Space switches preserve JSONC.** `/aidlc space <name>` updates the method
  glob in either `opencode.json` or `opencode.jsonc` without stripping comments
  or trailing commas, and keeps explicit persona memory paths aligned.
- **Construction swarm runs as task-tool fan-out only** (`AIDLC_USE_SWARM=1`
  is a loud no-op — no Workflow tool exists).
- **No session-end moment** — `SESSION_ENDED` audit events are not emitted.
  Pre-compaction validation DOES fire (`experimental.session.compacting`).
- **No statusline / welcome message** — use `/aidlc --status` and the progress
  lines at gates.
- **MCP servers**: none ship; configure your own under `mcp:` in
  `opencode.json` if needed.

## Verifying an install

```bash
aidlc doctor                               # all checks pass on a fresh init
opencode run --command aidlc -- "--status"  # /aidlc --status through the harness
```

The doctor's opencode-specific checks: the adapter plugin present at
`.opencode/plugin/`, a project-root `opencode.json` or `opencode.jsonc`
present, and `.opencode/command/aidlc.md` present.
