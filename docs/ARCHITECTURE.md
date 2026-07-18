# Architecture

## Boundary

```text
Host application / Chrome Side Panel / future desktop shell
                         |
                  <comma-editor>
                         |
      capability-declared DocumentAdapter + host events
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
9. The default save policy is explicit; immediate persistence requires an
   adapter or host to opt in.
10. Capability discovery is truthful. A document-only host does not gain fake
    comments or event history merely because the UI supports them elsewhere.

## Extension points

- `DocumentAdapter`: persistence and revision boundary.
- `capabilities`: host-declared load/save/comment/event surface plus
  `explicit | immediate` save policy.
- `comma-ai-request`: host decides whether Codex, Claude, another model, or no AI handles a request.
- `previewCommentBatch`: validates a structured response and opens a human confirmation queue; it never writes by itself.
- CSS custom properties: host-level visual tuning without DOM coupling.
- `resolveAsset`: optional adapter capability for turning document-relative
  image references into host-authorized URLs; editor-core never reads files.
- Future MCP: maps semantic document tools to an adapter/service, not to UI clicks.

## Promotion gate

Before `1.0`:

- the standalone, Review Studio, and ResearchLab hosts consume the package rather than copied files;
- the kanban document-only adapter graduates from a controlled contract test to a bounded detail-page pilot;
- schemas receive explicit migration rules;
- browser and long-document tests run in CI;
- a private/public distribution and licensing decision is made.

## Validated host profiles (v0.3)

| Host | Save policy | Comments | Host-owned behavior |
|---|---|---|---|
| Comma Review Studio | immediate | full + atomic batch | provider execution, review sessions, finding decisions, multi-turn writeback |
| ResearchLab Markdown Studio | explicit | full + atomic batch | RLP directory confinement, SHA-256 guard, 2 MB limit, project-local state |
| kanban-personal controlled Adapter | immediate | deliberately disabled | frontmatter, acceptance criteria, AI thread/queue, handoff, task state and three-way merge |
