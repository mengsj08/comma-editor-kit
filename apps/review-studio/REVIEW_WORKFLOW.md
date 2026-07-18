# Comma Review Studio — structured local review workflow

> status: local v0.3 reference host · verified: 2026-07-18 · canonical code: `/Users/a1234/Documents/AI-Agent-Hub/comma-editor-kit/apps/review-studio` · host: `127.0.0.1:8891`

## What the AI Review button does

1. Reads the current Markdown revision without editing the document.
2. Runs the selected local subscription CLI (Codex by default; Claude optional) in a no-write mode.
3. Requires structured JSON findings: exact quote, issue, action, priority, decision, evidence requirement, and rationale.
4. Validates every quote against the current document. Unique exact matches become `ready`; missing or ambiguous matches are blocked from automatic writeback.
5. Writes accepted, ready findings to `<document>.comments.json` as native comment records.
6. Stores the review ledger, dialogue, decisions, and writeback receipts in `data/review-sessions/<id>.json`. The document body and raw model trace are not duplicated there.

The review drawer supports later discussion. A continuation turn can add, update, or withdraw findings. Re-syncing updates the same AI comment by `source_key`; it never creates a duplicate for the same session/finding. A withdrawn finding remains in the ledger and marks its previously written comment `withdrawn` rather than erasing the audit trail.

## API surface

- `GET /api/review-sessions?path=<doc>` — session history summaries
- `POST /api/review-sessions` — start a structured review
- `GET /api/review-sessions/<id>` — full session ledger
- `POST /api/review-sessions/<id>/messages` — continue the review and apply finding operations
- `PUT /api/review-sessions/<id>/findings` — accept, propose, or reject one finding
- `POST /api/review-sessions/<id>/writeback` — revision-locked, idempotent batch comment sync

All writeback requires `session.base_rev == current document rev`. If the document changes while the model is running or before a later sync, the session becomes `needs_rebase` and no stale comments are written.

## Lark/Feishu principles borrowed — without adding a Lark dependency

- Stable localization: exact quote plus revision, source offset, prefix, and suffix.
- Native object boundary: document, comment, review session, finding, and writeback receipt remain separate facts.
- Post-write verification: every batch returns created, updated, skipped, and blocked receipts.
- Idempotency: `<session_id>:<finding_id>` is the stable write key.

This local host does not call Lark CLI or Feishu APIs. A future Lark adapter can consume the same validated finding/writeback contract.

## Verification evidence (2026-07-18)

- Deterministic core and HTTP tests: 5/5 passed.
- Legacy renderer/anchor regression: 5/5 anchors resolved correctly; upstream edit retained 5/5; deliberately rewritten quote produced exactly 1 stale anchor; no console errors.
- Block-edit regression: source reconstruction and byte fidelity passed; a rewritten commented block changed `resolved: true -> false`; no console errors.
- Real Codex initial review on a de-identified four-paragraph fixture: 8 findings, 8 unique ready anchors; first sync created 8 comments; immediate second sync created 0 and skipped 8.
- Real Codex continuation: F001 withdrawn and F002 revised; next sync updated exactly 2 comments, skipped 6, left the total at 8, and preserved 1 withdrawn audit record.
- In-app browser: review drawer, ledger card, dialogue, history, and source jump rendered and worked; source jump closed the drawer and highlighted exactly one paragraph; console errors were empty.

Codex is the default because it completed both real structured runs in the current environment (about 66–85 seconds for the small fixture). Claude remains selectable, but the current local Claude CLI did not return during the exploratory health check, so it is not marked live-verified here.

## Current limits

- A review request remains synchronous; the drawer shows `running`, but there is not yet a persistent background queue or cancel button.
- Documents over 300,000 characters are rejected; chunked review is not implemented.
- Anchored comments are local sidecar objects. Publishing them to Feishu/Lark requires a separate adapter and destination authorization.
