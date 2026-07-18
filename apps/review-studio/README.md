# Comma Review Studio

Comma Review Studio is the complete local reference host for Comma Editor Kit. It owns the capabilities that intentionally stay outside editor-core: filesystem persistence, local Codex or Claude execution, review-session ledgers, multi-turn finding updates, revision-locked comment writeback, and post-write receipts.

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
