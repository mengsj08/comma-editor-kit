# Canonical migration record

## 2026-07-18 promotion

The canonical code home moved from the active TaskSpace prototype at the June-local path `/Users/a1234/Documents/TaskSpace/_projects/comma-editor-kit` to this independent private repository.

The unique structured-review implementation from the June-local path `/Users/a1234/Documents/TaskSpace/_projects/md-collab-editor-spike` was copied into `apps/review-studio/` as a reference host. This preserves the working AI Review and comment-writeback workflow while the host is progressively changed to consume the shared `<comma-editor>` component.

The migration deliberately excluded:

- the organoid manuscript and its comment sidecar;
- review-session ledgers and raw AI traces;
- screenshots, logs, caches, and generated test results;
- copied kanban vendor snapshots;
- `node_modules`, `dist`, Chrome release builds, and browser artifacts.

The original directories remain read-only migration sources until host parity and launch-path switching are verified. They are not canonical development locations after this record.

## 2026-07-19 v0.3 host convergence

The first convergence slice is implemented in the canonical repositories:

- the public core versions `Document`, `Comment`, `Finding`, `ReviewSession`,
  `WritebackReceipt`, and `EditEvent`, and normalizes legacy snake/camel fields;
- adapters expose a truthful capability manifest and one of two save policies;
- Review Studio consumes `<comma-editor>` for the full document surface. Its
  copied renderer and anchor modules were removed; the review drawer remains a
  host workflow above public events and comment APIs;
- ResearchLab Markdown Studio consumes the same component through an explicit-
  save Adapter. Disk and comment writes remain revision-locked and confined to
  a confirmed RLP project;
- kanban-personal has a document-only Adapter and contract tests. It is not yet
  wired into the live detail page because that worktree contains active UI work;
  this preserves a clean, reviewable pilot boundary.

The next slice is the bounded kanban detail-page pilot, followed by removal of
its duplicate renderer/block editor only after parity tests pass. The public
`8891` launch path now runs canonical code while preserving the existing private
data directory; `8892` remains a parallel rollback service. The old TaskSpace
source stays as a rollback reference and is no longer the running application.
