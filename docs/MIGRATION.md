# Canonical migration record

## 2026-07-18 promotion

The canonical code home moved from the active TaskSpace prototype at `/Users/a1234/Documents/TaskSpace/_projects/comma-editor-kit` to this independent private repository.

The unique structured-review implementation from `/Users/a1234/Documents/TaskSpace/_projects/md-collab-editor-spike` was copied into `apps/review-studio/` as a reference host. This preserves the working AI Review and comment-writeback workflow while the host is progressively changed to consume the shared `<comma-editor>` component.

The migration deliberately excluded:

- the organoid manuscript and its comment sidecar;
- review-session ledgers and raw AI traces;
- screenshots, logs, caches, and generated test results;
- copied kanban vendor snapshots;
- `node_modules`, `dist`, Chrome release builds, and browser artifacts.

The original directories remain read-only migration sources until host parity and launch-path switching are verified. They are not canonical development locations after this record.
