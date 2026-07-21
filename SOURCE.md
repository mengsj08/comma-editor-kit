# Source and provenance

The component boundary was derived from two local, June-owned implementations:

- Example local source snapshot on June's Mac: `/Users/a1234/Documents/TaskSpace/_projects/md-collab-editor-spike`
- Example local source snapshot on June's Mac: `/Users/a1234/skills/skills/academic-paper-review-workbench/assets/site/editor`

The source audit on 2026-07-18 found `markdown.js` and `anchor.js` byte-identical across the two implementations while their page assemblers had already diverged. That evidence defined the reusable boundary.

Comma Editor Kit is a clean host-neutral implementation of that boundary. On 2026-07-18 it was promoted from the TaskSpace prototype into this independent repository. The unique structured-review workflow from `md-collab-editor-spike` was retained under `apps/review-studio/`; private manuscript data, comments, review ledgers, screenshots, raw traces, caches, and generated builds were not copied into Git.

Third-party runtime libraries and their licenses are installed from npm and preserved in package-lock metadata; `node_modules` and generated builds are ignored. This repository is marked `private: true` and has no public distribution license yet.
