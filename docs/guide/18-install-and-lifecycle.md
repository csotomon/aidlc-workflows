# Install and Lifecycle

The supported default is the self-contained `aidlc` command. The installer
authenticates a release, installs the binary and selected harness runtime, and
keeps versions side by side. `aidlc init` then creates or refreshes the project
projection locally. Bun, Node.js, Git Bash, and WSL are not runtime
prerequisites.

## Install

Choose one harness: `claude`, `kiro`, `kiro-ide`, `codex`, or `opencode`.

macOS and Linux:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  | sh -s -- --harness claude
export PATH="$HOME/.local/bin:$PATH"
```

The installer does not edit shell startup files by default. Pass
`--profile "$HOME/.profile"` to add one marked PATH block transactionally.

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP install-aidlc.ps1
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 -OutFile $installer
& $installer -Harness claude
```

Windows installs a stable `aidlc.cmd` under
`%LOCALAPPDATA%\aidlc\bin`, adds it to the current PowerShell session, and
prints the persistent PATH command when needed.

The permanent release trust model is SHA-256 checksums plus TLS and published
SLSA provenance attestations. The installer authenticates `version.json`
through `checksums.txt` before trusting asset names or hashes. Release
automation publishes a provenance attestation for every artifact; signing or
notarization is not part of the trust chain.

## Initialize a Project

Run init before opening the harness:

```bash
cd your-project
aidlc init --dry-run --verbose
aidlc init
aidlc doctor
```

`init` is local and transactional. It reads the installed runtime, creates the
complete harness and workspace shell, records a refresh baseline, and prints
the host-specific next step. It does not create a workflow intent and does not
open a network connection.

Claude's optional MCP defaults require consent. Use an explicit mode in
automation:

```bash
aidlc init --mcp defaults
aidlc init --mcp none
```

For exact scripted approval, read `data.planToken` from
`aidlc init --dry-run --json`, then apply the same options with
`--plan-token <token>`. Any source, option, or project-state change invalidates
the token.

### Root Files and Existing Projects

Init never replaces a project root wholesale:

| Surface | Policy |
|---------|--------|
| `.gitignore` | Own one marked AI-DLC block; preserve every byte outside it |
| `.mcp.json` | Merge only consented `mcpServers` entries; preserve user keys and overrides |
| `AGENTS.md` | Own one marked onboarding block; preserve project instructions |
| `.vscode/settings.json` | Merge only the Kiro IDE native trust entry |

Known unmarked files and JSON entries from historical shipped projections are
adopted only when their exact descriptor SHA-256 signature matches. Init wraps
or records those contributions without duplication. A modified or unknown
AI-DLC-looking block remains ambiguous and is refused even with `--force`.
Malformed JSON and malformed or duplicate markers are also hard conflicts.

`--force` permits replacement of locally modified framework-owned files. It
does not authorize ownership of unrelated root content or user-owned JSON
values.

### Init Classification and Selection

Every source path must be classified as a managed directory, a typed root
integration, or project-owned seed/runtime data. An unclassified source entry
is a packaging error. Init reports every target path with one action:

| Action | Meaning |
|--------|---------|
| `create` | Framework path is absent and will be added |
| `update` | Owned framework bytes will be refreshed |
| `merge` | A managed block, JSON map, or JSON array will be reconciled |
| `preserve` | Bytes are current, project-owned, or intentionally disabled |
| `remove` | A previously owned path was retired upstream |
| `conflict` | Ownership, integrity, marker, or JSON safety cannot be proved |

An existing project stamp selects its harness. Otherwise an explicit
`--harness`, the machine default, or the only installed harness wins in that
order. With several candidates, an interactive terminal presents a numbered
picker; non-interactive runs must pass `--harness`. Init also asks before
targeting an unrecognized directory and, on Claude, before adding optional MCP
defaults. Automation should pass `--project-dir`, `--harness`, and
`--mcp defaults|none` explicitly.

Successful init prints the matching host next step:

| Harness | Next step |
|---------|-----------|
| Claude Code | Open Claude Code and run `/aidlc --doctor` |
| Kiro CLI | Run `kiro-cli chat`, then `/aidlc --doctor` |
| Kiro IDE | Open the project in Kiro IDE, then run `/aidlc --doctor` |
| Codex CLI | Run `codex`, then `$aidlc --doctor` |
| OpenCode | Run `opencode`, then `/aidlc --doctor` |

## Upgrade, Roll Back, and Retain Versions

```bash
aidlc upgrade
aidlc upgrade --check
aidlc versions list
aidlc versions install 2.5.3 --harness claude
aidlc rollback
aidlc versions prune --yes
```

Upgrade installs a complete version before atomically changing the active
pointer. An interruption before that pointer change leaves the previous
version active. Rollback only selects an already retained complete version and
does not use the network.

Active, rollback, and project-pinned versions are protected from pruning.
Destructive commands prompt on a TTY and require `--yes` without one.

## Project Pins and CI

```bash
aidlc use 2.5.3
git add .aidlc-version
```

Commit `.aidlc-version`. Engine commands re-execute the exact retained binary
before project data loads. A missing or incomplete pinned version fails closed
with a `versions install` remediation. Machine-management commands continue to
use the active binary.

A clone or CI runner installs the committed version before init:

```bash
install.sh --version "$(cat .aidlc-version)" --harness claude --quiet --yes
aidlc init --mcp none --quiet
aidlc doctor --quiet
```

This bootstrap is non-disruptive: the machine install is side by side and init
reconciles only declared framework surfaces. Restricted CI can consume a
reviewed offline package instead.

## Harness Management

```bash
aidlc harness list
aidlc harness add codex
aidlc harness default codex
aidlc harness remove claude --yes
```

`harness add` installs the running version's runtime, never a surprise latest
version. Removing the final harness leaves the lifecycle command available;
`aidlc harness add <name>` restores project operations.

## Offline, Proxies, Mirrors, and CAs

Create and verify a flat offline package:

```bash
aidlc package create --version 2.5.3 --harness claude \
  --target linux-x64 --output ./aidlc-offline
aidlc package verify ./aidlc-offline
install.sh --from ./aidlc-offline --offline --harness claude
```

Windows uses `install.ps1 -From .\aidlc-offline -Offline -Harness claude`.
`--offline` or `AIDLC_OFFLINE=1` forbids sockets before mutation. Local init,
rollback, versions listing, package verification, and plugin inspection still
work.

Release settings resolve in flag, environment, machine-config, default order:

| Setting | Environment | Machine config |
|---------|-------------|----------------|
| Offline | `AIDLC_OFFLINE=1` | `aidlc config global set offline on` |
| Mirror | `AIDLC_RELEASE_BASE_URL` | `aidlc config global set release-base-url <https-url>` |
| CA bundle | `AIDLC_CA_BUNDLE` | `aidlc config global set ca-bundle <absolute-path>` |

Standard `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` variables are honored.
Mirrors must serve the same flat authenticated release contract. Non-loopback
release URLs must use HTTPS and cannot contain credentials, queries, or
fragments.

## Plugins

```bash
aidlc plugin list --verbose
aidlc plugin sync
aidlc plugin sync --prune-missing
```

Claude and Codex can report a proved full host inventory. Kiro is
current-root-only unless its host turn supplies the plugin root; outside that
context aggregate state is reported as unavailable rather than guessing.

Plugin status is `current`, `run: aidlc plugin sync`, or
`needs attention: <remediation>`. Sync stages every enabled plugin and commits
one rollback-safe project transaction. Plain sync never deletes content for a
missing source. `--prune-missing` requires full inventory, confirmation, and
unchanged ownership hashes.

## Output and Exit Codes

Lifecycle commands use one typed result across human, `--quiet`, and `--json`
modes. `--no-color` disables ANSI, and mutating commands accept `--yes` where
confirmation is required.

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Operational failure |
| 2 | Usage error |
| 3 | Required network result unavailable |
| 4 | Integrity or safety refusal |
| 5 | Action required before completion |

Bare help and management listings are cache-only. Interactive human
`aidlc doctor` may refresh stale update metadata within 750 ms. Non-TTY,
`--json`, and `--quiet` doctor runs are network-free unless
`--check-updates` is explicit; explicit checks use a 15-second total budget.

## Help, Notices, and Completions

`aidlc --help` is the compact human command list. `aidlc help --all` includes
hidden graph, sensor, runtime, generated-surface, and adapter routes for
debugging. Interactive help and `aidlc harness list` may append a validated
cached update notice; they never open a network connection. Refresh the cache
through interactive doctor, `aidlc doctor --check-updates`, or
`aidlc upgrade --check`.

Generate completions from the same route registry used by help:

```bash
aidlc completions bash
aidlc completions zsh
aidlc completions fish
aidlc completions powershell
```

For example, install bash output under
`~/.local/share/bash-completion/completions/aidlc`, zsh output in a directory
on `$fpath`, or fish output at
`~/.config/fish/completions/aidlc.fish`. PowerShell output can be loaded into
the current session with `aidlc completions powershell | Out-String |
Invoke-Expression`.

## Transactions and Doctor

Project and machine mutations stage on the destination filesystem, validate
the complete candidate, and commit through atomic renames. Abandoned private
staging is swept lazily after ownership checks. On Windows, the active-command
pointer and uninstall cleanup use a recoverable continuation.

`aidlc doctor` reports the active runtime, project stamp and pin, native host
trust, installed-versus-composed plugins, transaction staging, stale pin
registrations, update cache, and the project health checks. Follow a named
leftover-staging remediation; do not delete a live transaction directory.
The complete representative transcript is in
[CLI Commands](12-cli-commands.md#aidlc---doctor--health-check).

## Manual Projection

Copying `dist/<harness>/` is an advanced project-projection path for source
checkouts. This copy channel remains Bun-invoked, so install Bun and copy the
complete distribution root so harness files, the workspace shell, and root
integrations stay together. Native installations use the separately generated
`dist-release/<harness>/` payload through `aidlc init`. Merge root files
according to the policies above; `aidlc init` is safer for existing projects.

Direct `bun <harness>/tools/*.ts` execution remains a developer/debug route.
Third-party plugins may also declare arbitrary Bun-backed TypeScript commands;
that plugin is responsible for declaring its runtime requirement.

## Uninstall

```bash
aidlc uninstall
aidlc uninstall --purge --yes
```

Uninstall never changes project trees. Without `--purge`, it preserves machine
configuration, update cache, pins, and the default harness. Package-manager
installs must be upgraded or removed through that package manager.
