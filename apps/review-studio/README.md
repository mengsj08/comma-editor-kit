# Comma Review Studio

Comma Review Studio is the complete local reference host for Comma Editor Kit. It owns the capabilities that intentionally stay outside editor-core: filesystem persistence, local Codex or Claude execution, review-session ledgers, multi-turn finding updates, revision-locked comment writeback, conflict recovery, document history, and portable exports.

It also owns quote-scoped conversations. Selecting source text exposes `添加批注 / 快速解释 / 深入讨论`: quick explanations are transient; deep discussions are persisted as parent-linked message trees with comments, explicit forks, and message-level comment writeback.

## Run

```bash
COMMA_REVIEW_PORT=8891 python3 server.py
```

Open `http://127.0.0.1:8891/?doc=paper.md`.

For a private document directory, set an explicit data root:

```bash
COMMA_REVIEW_DATA_ROOT=/absolute/private/directory COMMA_REVIEW_PORT=8891 python3 server.py
```

The server binds only to `127.0.0.1`. It accepts Markdown files only and confines document access to the selected data root. Private documents, comment sidecars, review sessions, quote conversation ledgers, event ledgers, logs, screenshots, and raw model traces must not be committed.

## Version and export center

Every successful immediate save records a content-addressed snapshot under
`<data-root>/.comma-review/versions/`. A named checkpoint points at the same
immutable blob. Restoring a checkpoint writes a new timeline entry instead of
deleting later history. If a save loses its optimistic-revision race, the
attempted body is retained under `.comma-review/drafts/`; the page reloads the
newest disk revision and offers diff, revision-checked recovery, or dismissal.

The export center provides exact Markdown, Markdown with appended review
comments, and a Review Package ZIP containing the selected manuscript,
document-relative image assets, native comments, matching review/conversation
ledgers, the per-document hash-only `CommentEvent` ledger, and version
snapshots. The global event ledger and raw AI traces are
excluded. DOCX and PDF use a detected local LibreOffice executable; set
`COMMA_REVIEW_SOFFICE_BIN=/absolute/path/to/soffice` when auto-detection is not
appropriate.

## Local CLI capability

`GET /api/runtime/capabilities` reports Codex and Claude installation, version,
and login readiness. The header badge uses the same resolver as quick explain,
quote-scoped discussions, and structured review, so a missing provider is
disabled before invocation instead of returning a successful stub.

The resolver augments a minimal launchd `PATH` with conventional macOS CLI
locations and passes that path to child processes (important for the Node-based
Codex launcher). Explicit installations can be pinned without changing global
shell state:

```bash
COMMA_REVIEW_CODEX_BIN=/absolute/path/to/codex \
COMMA_REVIEW_CLAUDE_BIN=/absolute/path/to/claude \
python3 server.py
```

Capability detection runs only `--version` and read-only login-status commands;
their authentication output is discarded and page load never starts a model
task.

## Comment lifecycle migration

Legacy comment sidecars remain readable without a write. Inspect a copied data
root with the Slice A migration in dry-run mode:

```bash
python3 migrate_slice_a.py --data-root /absolute/path/to/copied-data
```

`--apply` is reserved for an explicitly authorized migration. It verifies all
records first and creates byte-identical sidecar/session backups under
`.comma-review/migration-backups/` before the first normalized write. The
command reports counts and field names only; it does not print comment or
manuscript content.

## Verify

From the repository root:

```bash
npm run test:review
```

The browser regressions require a running server and the kanban Playwright environment:

```bash
COMMA_REVIEW_PORT=8891 python3 server.py
/Users/a1234/Documents/AI-Agent-Hub/kanban-personal/shared/toolkit/kanban/.venv/bin/python test_headless.py
/Users/a1234/Documents/AI-Agent-Hub/kanban-personal/shared/toolkit/kanban/.venv/bin/python test_blocks.py
```

See `REVIEW_WORKFLOW.md` for the API and writeback contract. `SPIKE_REPORT.md` is retained only as migration provenance.
