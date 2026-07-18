# Comma Editor Kit agent instructions

Read `README.md` and `docs/ARCHITECTURE.md` before changing the component boundary.

## Invariants

- Markdown source is canonical; rendered HTML is disposable.
- Keep `src/core/` and `src/element/` free of Chrome, filesystem, Codex, Claude, and MCP assumptions.
- Add host capabilities through adapters or composed events.
- Never weaken optimistic revision checks or silently resolve ambiguous comment anchors.
- Keep Chrome capture user-initiated and site-agnostic. Do not add cookies, debugger, webRequest, persistent host permissions, or remote scripts without explicit June approval.
- Do not copy credentials, browser profiles, private document bodies, or raw AI traces into fixtures or reports.
- `apps/review-studio/` is the reference host, not editor-core. Provider execution, filesystem access, and review-session persistence must stay in that host boundary.
- `academic-paper-review-workbench`, ResearchLab Workbench, and kanban remain independent consumers until each adapter migration is separately verified.

## Verification

Run:

```bash
npm run check
/Users/a1234/Documents/AI-Agent-Hub/kanban-personal/shared/toolkit/kanban/.venv/bin/python tests/browser_smoke.py
/Users/a1234/Documents/AI-Agent-Hub/kanban-personal/shared/toolkit/kanban/.venv/bin/python tests/chrome_smoke.py
```

The Chrome smoke test uses a temporary Playwright profile. Never point it at a real Chrome profile.
