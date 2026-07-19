# Troubleshooting

This chapter covers common issues and their solutions, organized by symptom.

> **Harness note.** Symptoms and fixes below are written for **Claude Code** (hook
> filenames, `settings.json` blocks, compaction behaviour). The deterministic core
> — state, audit, the engine — behaves identically on every harness, but the
> shell-level surfaces differ: the other harnesses wire hooks and config their own way
> (see [Running on other harnesses](harnesses/README.md)). Where a fix names a
> `.claude/` path or a Claude mechanic, the equivalent lives in your harness's
> config dir.

---

## Quick Fix Table

| Symptom | Quick Fix |
|---------|-----------|
| No audit entries appearing | Run `aidlc doctor` and verify native hook trust |
| State file corrupted | Run `/aidlc --doctor`, compare against state template |
| Stuck at approval gate | Type your response; use `/aidlc --stage <target>` to jump past it |
| Context compacted mid-session | Run `/aidlc` to resume from checkpoint |
| Audit log too large | Rename to `audit-YYYY-MM.md`; a fresh one is created automatically |
| Hooks appear to hang | Remove stale lock dirs from system temp directory (see below) |
| Statusline shows "ready" | Check `aidlc-state.md` has a `**Lifecycle Phase**` field |
| Statusline not appearing | Verify `aidlc` is on PATH and `settings.json` routes `aidlc statusline` |
| Subagent timed out | Run `/aidlc` to retry or run the stage inline |

---

## Native Install Channel

| Symptom or error | Resolution |
|------------------|------------|
| `Checksum mismatch for <asset>.` or `<asset>: checksum mismatch` | Stop. Do not reuse the downloaded directory. Download the release assets and `checksums.txt` again from the same version, or have the owner of an offline package recreate it with `aidlc package create`. |
| `command not found: aidlc` after `install.sh` | Add the installer-reported bin directory to `PATH` (normally `export PATH="$HOME/.local/bin:$PATH"`), open a new shell, and run `aidlc doctor`. |
| `aidlc.cmd` exits 4 or the Windows active pointer is invalid | Do not edit `%LOCALAPPDATA%\aidlc\active-executable`. Rerun the same verified `install.ps1 -Harness <name>` or use `aidlc rollback --version <retained-version>` from a retained executable. |
| `pending Windows uninstall` or a Windows uninstall recovery failure | Close active AI-DLC commands and run `aidlc doctor`. A valid continuation resumes on the next command; do not delete its temp journal, cleanup script, or machine fence independently. |
| `locally modified or unowned` or `managed block was locally modified` from `aidlc init` | Run `aidlc init --dry-run --verbose` and review every conflict. Use `--force` only to replace framework-owned bytes; it never authorizes deletion of unrelated project content. |
| `legacy root integration ambiguous; move or delete the unmarked AI-DLC content` | Exact historical signatures migrate automatically. This file differs from every known signature, so preserve project-owned text, move or delete only the unmarked legacy AI-DLC block, then rerun init. `--force` cannot claim ambiguous content. |
| `managed markers are missing, duplicated, or malformed` | Repair the named root file so it has exactly one matching `BEGIN AI-DLC` / `END AI-DLC` pair, or remove the broken AI-DLC block and rerun `aidlc init`. |
| `project runtime <version> is incompatible with selected engine <version>` | Install and select a compatible retained version with `aidlc versions install <version>` and `aidlc use <version>`, or refresh the project intentionally with `aidlc init`. |
| An upgrade was interrupted and `aidlc version` still shows the prior release | This is the safe pre-pointer state: the old command remains active. Run `aidlc doctor`, then rerun the same `aidlc upgrade --version <version>` command. A complete unused retained version may remain and is reported by `aidlc versions list`. |
| `another AI-DLC mutation holds .../.aidlc-transaction.lock` | Let the active init/lifecycle command finish. If its process no longer exists, rerun the command; stale owner-private staging is swept only after the lock is safely reclaimed. |
| `existing aidlc is managed by Homebrew` / `Nix`, or the destination command is `not owned by the AI-DLC installer` | Upgrade through the reported package manager. To keep a separate native install, set `AIDLC_BIN_DIR` explicitly to an empty user-owned directory. Never replace a mixed-ownership command in place. |
| `update cache is invalid` or machine config is rejected | Run `aidlc config global list`. Repair or remove only the named `%LOCALAPPDATA%\aidlc\config.json` (Windows) or `~/.local/share/aidlc/config.json` (macOS/Linux); unknown keys and stored credentials are rejected. |
| `versions prune`, `harness remove`, or `uninstall` requires `--yes` | The command is running without an interactive stdin. Review the listed removals, then rerun with `--yes`; integrity refusals cannot be bypassed. |

Native `aidlc doctor` also checks the active command pointer, rollback
eligibility, retained pin completeness, stale pin registrations, abandoned
transaction staging, project version skew, and whether native host
hooks and permission/trust entries consistently select the native command.

---

## Hooks Not Firing

**Symptom**: No entries appearing in the intent's `audit/` shards after file writes, or no subagent completion logs.

### `aidlc` not installed or not trusted

All 12 host hooks route through the self-contained `aidlc` command. Run
`aidlc doctor` from the project and address its installed-runtime and native
command trust rows. If the command is missing, add the installer-reported bin
directory to PATH and restart the harness. Bun is relevant only when directly
running framework TypeScript sources or when a third-party plugin declares a
Bun-backed command.

### Reviewer tool calls refused ("reviewer read-scope: ...")

During a per-unit Construction review, the reviewer-scope hook refuses the dispatched reviewer's tool calls that reach into sibling units' `construction/` paths (the stage-protocol §12a read-scope bound); the refusal message names the scoped unit and the passed contract paths, and each refusal records a `REVIEWER_SCOPE_BLOCKED` audit row. If your own source tree contains a `construction/` directory unrelated to AI-DLC units (so legitimate reviewer reads are being refused), set `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` to disable enforcement; the prose bound still governs. A reviewer being refused with NO review in flight means a stale dispatch record - check `/aidlc --doctor`'s hook-drop counters (`reviewer-scope.drops`) and delete `<record>/.aidlc-reviewer-dispatch.json` if present (records older than 6 hours are ignored and cleaned automatically).

### Hook not configured

Hooks are registered project-wide in `.claude/settings.json` (as of v0.6.0;
earlier versions declared the workflow-spine hooks in the SKILL.md
frontmatter). Verify that it routes the native command for `PreToolUse`,
`PostToolUse`, `PreCompact`, `SubagentStop`, `Stop`, `SessionStart`, and
`SessionEnd`. Run `aidlc init --dry-run`, then `aidlc init` to refresh an old
projection.

---

## State File Issues

**Symptom**: Orchestrator reports corrupted state, or workflow behaves unexpectedly.

### State file missing

The state file is created during Initialization or when a scope is provided to `/aidlc`.

- Run `/aidlc --status` to confirm no workflow is active
- Run `/aidlc` or `/aidlc <scope>` to start a fresh workflow

### State file corrupted

The `validate-state.ts` hook checks for two required sections on every compaction: `## Stage Progress` and `## Current Status`. To repair:

1. Run `/aidlc --doctor` and address any reported state, graph, or hook issues
2. If the generated Stage Progress rows are stale, re-run the engine path that owns state resync: start or resume the workflow with `/aidlc`, or change scope through `/aidlc --scope <scope>` so the compiled graph and scope grid are reapplied
3. Use `.claude/knowledge/aidlc-shared/state-template.md` only as the section and field contract; do not restore stage rows by hand from the template

---

## Subagent Timeouts

**Symptom**: Subagent stages (Workspace Detection, Reverse Engineering, Code Generation) return errors or truncated output.

### What happens

The framework follows a built-in retry protocol:

1. **Automatic retry** with a reduced-context prompt
2. **If retry fails**, two options:
   - **Run inline** — execute the stage directly in the main conversation (no subagent boundary)
   - **Skip and revisit** — mark the stage incomplete and return later

### Manual recovery

Re-run `/aidlc` — it detects the `[-]` (in-progress) state and offers to resume or redo the stage. Check the `audit/` shards for the error entry to understand what failed.

---

## Approval Gate Stuck

**Symptom**: The workflow is waiting for your response at an approval gate.

### How to proceed

Type your response when prompted. Options are:

- **Approve** — continue to the next stage
- **Request Changes** — provide feedback for revision

### Revision loop escape hatch

After 3 revision cycles on the same stage, a third option appears: **Accept as-is**. This archives the current version and moves on.

### Skipping a stage

Use `/aidlc --stage <target>` to jump to a different stage. Intervening stages will be marked `[S]` (skipped) in the state file.

---

## Context Compaction

**Symptom**: Claude Code summarized earlier conversation context. The session may feel like it "forgot" recent discussion.

### What is preserved

All record-dir artifacts, `aidlc-state.md`, the `audit/` shards, and `.aidlc-recovery.md` persist on disk. Only in-memory conversation context and partial in-progress work not yet written to files is lost.

### How to recover

Run `/aidlc` after compaction. The framework:

1. Reads `aidlc-state.md` to load workflow position
2. Compares `.aidlc-recovery.md` against the state file — warns if they differ
3. Offers four resume options

If the recovery breadcrumb warns about a mismatch, choose **Redo current stage** to safely re-execute the stage that was in progress during compaction.

---

## Audit Log Growing Too Large

**Symptom**: this clone's audit shard has grown to thousands of lines over a long project.

### How to archive

```bash
# from the intent's record dir; <host>-<clone>.md is this clone's shard
mv audit/<host>-<clone>.md audit-archive/<host>-<clone>-2026-02.md
```

The next `/aidlc` invocation (or any hook-triggered write) creates a fresh shard. All audit content is safe to archive — the engine does not read the `audit/` shards for routing decisions.

### Git considerations

The `audit/` shards are committed (not gitignored) — see [What to Commit vs. Gitignore](14-artifacts-reference.md#what-to-commit-vs-gitignore). Each clone writes its own `<host>-<clone>.md` shard, so concurrent appends never merge-conflict; consider archiving (see above) before commits to keep diffs manageable.

---

## Lock Files Left Behind

**Symptom**: Hooks appear to hang briefly then skip. Subsequent audit entries are not written.

The audit hooks use `mkdir`-based locking (via `lib.ts`) to prevent concurrent writes. If a hook is interrupted, the lock directory may persist. Lock files are created in the system temp directory (`os.tmpdir()` -- typically `/tmp/` on macOS/Linux, `%TEMP%` on Windows).

### Finding stale locks

```bash
# macOS / Linux
ls -la /tmp/.aidlc-*

# Windows (PowerShell)
Get-ChildItem $env:TEMP -Filter ".aidlc-*"
```

Lock directories are named `.aidlc-audit-<hash>.lock` and `.aidlc-subagent-<hash>.lock` inside the system temp directory.

### Clearing stale locks

```bash
# macOS / Linux
rm -rf /tmp/.aidlc-audit-*.lock /tmp/.aidlc-subagent-*.lock

# Windows (PowerShell)
Remove-Item "$env:TEMP\.aidlc-audit-*.lock", "$env:TEMP\.aidlc-subagent-*.lock" -Recurse -Force
```

Safe to run at any time when no AI-DLC workflow is actively executing. Locks are transient and recreated on each hook invocation.

---

## Statusline Issues

### Shows "ready" when workflow is active

The statusline reads the `**Lifecycle Phase**` field from `aidlc-state.md`. If that field is missing or empty, it falls back to `[AIDLC] ready`.

**Fix:** Run `/aidlc --doctor` to check state file integrity. Verify the `## Current Status` section contains a `**Lifecycle Phase**` entry.

### Shows stale data

Expected behavior — the statusline updates when the state file is next written, typically at stage transitions.

### Not appearing at all

1. `aidlc` not on PATH -- the statusline is invoked as `aidlc statusline`
2. Missing `settings.json` block -- verify the `statusLine` configuration exists
3. No state file -- the statusline correctly shows `[AIDLC] ready` when no workflow is active

---

## Using `--doctor`

The `--doctor` utility command validates your setup. Run it whenever something seems wrong:

```
/aidlc --doctor
```

It checks the active installed runtime, project stamp and pin, native command
trust, transaction staging, plugin composition, hook availability, project
structure, workspace shell, state/audit consistency, graph integrity, scopes,
stage schemas and references, and keyword overlap. It also reports advisory
rule drift and paired sensor coverage. Hook drops marked `[degraded]` fail
doctor; `[advisory]` drops do not. Interactive doctor may refresh stale update
metadata within 750 ms; non-TTY, JSON, and quiet runs stay cache-only unless
`--check-updates` is explicit. See [Install and
Lifecycle](18-install-and-lifecycle.md#transactions-and-doctor) for the full
machine lifecycle rows.

See [CLI Commands](12-cli-commands.md#aidlc---doctor--health-check) for full details on what each check validates and how to fix failures.

---

## Next Steps

- [State Tracking and Audit Trail](10-state-and-audit.md) — State file structure
- [Session Management](11-session-management.md) — Resume options after compaction
- [CLI Commands](12-cli-commands.md) — `--doctor`, `--status`, `--stage` usage
- [Glossary](glossary.md) — Definitions for compaction, recovery breadcrumb, hook
