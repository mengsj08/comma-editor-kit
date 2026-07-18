# Architecture

## Boundary

```text
Host application / Chrome Side Panel / future desktop shell
                         |
                  <comma-editor>
                         |
        DocumentAdapter + host-level events
                         |
       file / HTTP / localStorage / chrome.storage
```

The component consumes a document contract. It does not know where a document lives and it does not invoke an AI provider directly.

`apps/review-studio/` is a composed reference host above this boundary. It may invoke a guarded local provider and persist files because those capabilities remain outside `src/core/` and `src/element/`.

## Core invariants

1. Markdown is the canonical body. Rendered HTML is disposable.
2. An edit replaces a known source range; unedited source remains byte-identical.
3. Saves carry `baseRev`. A stale revision is rejected, never overwritten.
4. Comments store a quote snapshot and a source locator. Ambiguity is reported instead of guessed.
5. AI-proposed comments are previewed against a fixed revision and confirmed as one atomic batch.
6. Mutations append an actor-labelled event through the adapter.
7. Rendered HTML is sanitized before entering the shadow DOM.
8. Chrome permissions stay in the Chrome wrapper.

## Extension points

- `DocumentAdapter`: persistence and revision boundary.
- `comma-ai-request`: host decides whether Codex, Claude, another model, or no AI handles a request.
- `previewCommentBatch`: validates a structured response and opens a human confirmation queue; it never writes by itself.
- CSS custom properties: host-level visual tuning without DOM coupling.
- Future MCP: maps semantic document tools to an adapter/service, not to UI clicks.

## Promotion gate

Before `1.0`:

- both the standalone host and academic review workbench consume the package rather than copied files;
- one additional, non-paper host validates the adapter contract;
- schemas receive explicit migration rules;
- browser and long-document tests run in CI;
- a private/public distribution and licensing decision is made.
