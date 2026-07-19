#!/usr/bin/env python3
"""Browser acceptance for the canonical <comma-editor> Review Studio surface.

Run with the kanban Playwright venv. The server must already be running on
COMMA_REVIEW_PORT (default 8891). The fixture is restored on exit.
"""
import json
import os
import base64
import time
import urllib.request

from playwright.sync_api import sync_playwright

PORT = os.environ.get("COMMA_REVIEW_PORT", "8891")
BASE = f"http://127.0.0.1:{PORT}"
URL = f"{BASE}/?doc=paper.md"
ROOT = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(ROOT, "data", "paper.md")
COMMENTS = DOC + ".comments.json"
COMMENT_EVENTS = DOC + ".comment-events.jsonl"
ASSET = os.path.join(ROOT, "data", "scientific-control.png")
REVIEW_ROOT = os.path.join(ROOT, "data", "review-sessions")
SLICE_C_SESSION_ID = "review-c0ffee000001"
SLICE_C_RUN_ID = "run-c0ffee000001"
SLICE_C_SESSION = os.path.join(REVIEW_ROOT, SLICE_C_SESSION_ID + ".json")
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9xkAAAAASUVORK5CYII="
)


def api(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def read_doc():
    with open(DOC, encoding="utf-8") as handle:
        return handle.read()


def reset_comments():
    for path in (COMMENTS, COMMENT_EVENTS):
        if os.path.exists(path):
            os.remove(path)


def write_slice_c_preview(document, comments_rev, human_comment_id, withdraw_comment_id):
    def proposal(finding_id, quote, issue, action):
        return {
            "id": finding_id, "section": "Scientific media fixture",
            "quote_text": quote, "issue": issue, "action": action,
            "priority": "P1", "decision": "accepted",
            "evidence_requirement": "", "rationale": "Synthetic browser contract.",
            "context_before": "", "context_after": "", "version": 1,
            "applied_comment_id": "", "applied_signature": "",
            "anchor_state": "ready", "anchor_matches": 1,
            "source_locator": {"task_path": "paper.md", "body_rev": document["rev"]},
        }

    created = proposal(
        "F-CREATE", "Scientific control image",
        "The synthetic image note needs a source boundary.", "Add a bounded review note.")
    updated = proposal(
        "F-HUMAN", "Scientific media fixture",
        "The human-edited note has a proposed revision.", "Apply only after explicit confirmation.")
    operations = [
        {"id": "op-create", "action": "create", "finding_id": "F-CREATE",
         "supersedes_finding_id": "", "target_comment_id": "", "reason": "new finding",
         "proposed_comment": created, "human_edited_target": False},
        {"id": "op-human", "action": "update", "finding_id": "F-HUMAN",
         "supersedes_finding_id": "F-HUMAN", "target_comment_id": human_comment_id,
         "reason": "human-edited target", "proposed_comment": updated,
         "human_edited_target": True},
        {"id": "op-withdraw", "action": "withdraw", "finding_id": "F-WITHDRAW",
         "supersedes_finding_id": "F-WITHDRAW", "target_comment_id": withdraw_comment_id,
         "reason": "finding no longer applies", "proposed_comment": None,
         "human_edited_target": False},
        {"id": "op-keep", "action": "keep", "finding_id": "F-HUMAN",
         "supersedes_finding_id": "", "target_comment_id": human_comment_id,
         "reason": "lineage stays visible", "proposed_comment": None,
         "human_edited_target": True},
        {"id": "op-blocked", "action": "blocked", "finding_id": "F-BLOCKED",
         "supersedes_finding_id": "", "target_comment_id": "",
         "reason": "anchor is ambiguous", "proposed_comment": None,
         "human_edited_target": False},
    ]
    run = {
        "schema_version": "comma-review-run/v1", "id": SLICE_C_RUN_ID,
        "session_id": SLICE_C_SESSION_ID, "parent_session_id": "review-baseline0001",
        "mode": "incremental",
        "input": {"document_rev": document["rev"], "comments_rev": comments_rev,
                  "changed_block_ids": ["synthetic-block"],
                  "affected_comment_ids": [human_comment_id, withdraw_comment_id]},
        "operations": operations, "model_receipt": {"tool": "mock", "returncode": 0},
        "writeback_receipt_id": "", "status": "preview",
        "created_at": "2026-07-20T10:00:00", "updated_at": "2026-07-20T10:00:00",
    }
    session = {
        "id": SLICE_C_SESSION_ID, "doc_path": "paper.md",
        "base_rev": document["rev"], "document_rev": document["rev"],
        "tool": "codex", "status": "preview", "summary": "Synthetic operation preview.",
        "findings": [created, updated], "messages": [], "writeback_receipts": [],
        "run": run, "created_at": "2026-07-20T10:00:00",
        "updated_at": "2026-07-20T10:00:00",
    }
    os.makedirs(REVIEW_ROOT, exist_ok=True)
    with open(SLICE_C_SESSION, "w", encoding="utf-8") as handle:
        json.dump(session, handle, ensure_ascii=False, indent=2)


def editor_snapshot(page):
    return page.evaluate("""() => {
      const editor = document.querySelector('comma-editor');
      const root = editor.shadowRoot;
      const resolutions = editor._comments
        .filter(comment => comment.kind === 'anchored')
        .map(comment => editor._resolveComment(comment));
      return {
        title: editor.documentState.title,
        rev: editor.documentState.rev,
        blocks: root.querySelectorAll('.ce-block').length,
        katex: root.querySelectorAll('.katex').length,
        katexErrors: root.querySelectorAll('.katex-error').length,
        tables: root.querySelectorAll('table').length,
        tableScrolls: root.querySelectorAll('.ce-table-scroll').length,
        figures: root.querySelectorAll('figure').length,
        images: root.querySelectorAll('.ce-preview img').length,
        imageStates: Array.from(root.querySelectorAll('.ce-preview img')).map(image => image.dataset.assetState),
        code: root.querySelectorAll('pre code').length,
        comments: root.querySelectorAll('.ce-comment').length,
        resolved: resolutions.filter(item => Number.isInteger(item.blockIndex) && item.blockIndex >= 0).length,
        stale: resolutions.filter(item => item.state === 'missing').length,
        ambiguous: resolutions.filter(item => item.state === 'ambiguous').length,
        resolutionStates: resolutions.map(item => item.state),
        theme: editor.getAttribute('theme'),
        shellBackground: getComputedStyle(root.querySelector('.ce-shell')).backgroundColor,
        paperBackground: getComputedStyle(root.querySelector('.ce-document')).backgroundColor,
        textureDisplay: getComputedStyle(root.querySelector('.ce-shell'), '::before').display,
      };
    }""")


def main():
    reset_comments()
    original = read_doc()
    original_slice_c_session = None
    if os.path.exists(SLICE_C_SESSION):
        with open(SLICE_C_SESSION, "rb") as handle:
            original_slice_c_session = handle.read()
    scientific_fixture = original + """

## Scientific media fixture

![Scientific control image](scientific-control.png)

| Marker | Cohort | Condition | Assay | Timepoint | Replicate | Mean | SD | CI | P value | Effect | Batch | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EPCAM | Validation | Treated | Imaging | Day 14 | R03 | 18.2 | 1.4 | 16.8–19.6 | 0.004 | 1.82 | B-2026-07 | PMID:00000000 | controlled fixture |
"""
    with open(DOC, "w", encoding="utf-8") as handle:
        handle.write(scientific_fixture)
    with open(ASSET, "wb") as handle:
        handle.write(PNG_1X1)
    results = {}
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.on("pageerror", lambda error: errors.append("PAGEERROR: " + str(error)))
            started = time.time()
            page.goto(URL, wait_until="load")
            page.locator("comma-editor").locator(".ce-block").first.wait_for(timeout=15000)
            page.locator("comma-editor").locator(".katex").first.wait_for(timeout=15000)
            page.wait_for_function("document.querySelector('comma-editor').shadowRoot.querySelector('.ce-preview img')?.dataset.assetState === 'ready'")
            page.wait_for_function("document.querySelector('comma-editor').documentState.rev.length > 0")
            first = editor_snapshot(page)
            first["fullLoadMs"] = round((time.time() - started) * 1000)
            first["rerenderMs"] = round(page.evaluate("""() => {
              const editor = document.querySelector('comma-editor');
              const started = performance.now();
              editor._renderDocument();
              return performance.now() - started;
            }"""))
            results["public_component_render"] = first
            results["host_actions"] = page.evaluate("""() => {
              const root = document.querySelector('comma-editor').shadowRoot;
              return {
                primary: Array.from(root.querySelectorAll('[data-el=toolbar-primary] [data-toolbar-action]')).map(button => button.textContent.trim()),
                overflow: Array.from(root.querySelectorAll('[data-el=toolbar-overflow-menu] [data-toolbar-action]')).map(button => button.textContent.trim()),
                panelTitle: root.querySelector('[data-el=comment-panel-title]').textContent,
              };
            }""")
            page.evaluate("document.querySelector('comma-editor').shadowRoot.querySelector('[data-toolbar-action=article-overview]').click()")
            page.wait_for_function("document.querySelector('#overview-drawer').classList.contains('open')")
            results["overview_shell"] = {
                "title": page.locator("#overview-drawer h2").text_content(),
                "claims": page.locator("#overview-drawer .capability-boundary-card li").count(),
                "revision": page.locator("#overview-rev").text_content(),
            }
            page.locator("#overview-close").click()

            page.evaluate("document.querySelector('comma-editor').shadowRoot.querySelector('[data-toolbar-action=ai-review]').click()")
            page.wait_for_function("!document.querySelector('#review-preflight-modal').hidden && !document.querySelector('#review-preflight-primary').disabled")
            results["review_preflight"] = {
                "title": page.locator("#review-preflight-title").text_content(),
                "route": page.locator("#review-preflight-route-code").text_content(),
                "primary": page.locator("#review-preflight-primary").text_content(),
                "claims": page.locator("#review-preflight-modal .preflight-report-grid article").count(),
            }
            page.locator("#review-preflight-close").click()

            results["document_only_boundary"] = page.evaluate("""async () => {
              const fixture = document.createElement('comma-editor');
              fixture.id = 'document-only-fixture';
              fixture.toolbarActions = [
                { id: 'document-info', label: 'Info', slot: 'primary', appliesTo: 'document.load' },
                { id: 'comments', label: 'Forbidden count', slot: 'primary', appliesTo: 'comments.list', count: 'comments' },
              ];
              fixture.commentActions = [
                { id: 'edit', label: 'Forbidden edit', appliesTo: { capability: 'update', target: 'comment' } },
              ];
              fixture.adapter = {
                capabilities: {
                  savePolicy: 'explicit', document: { load: true, save: false, replace: false },
                  comments: { list: false, create: false, batch: false, update: false, delete: false },
                  events: { list: false }, assets: { resolve: false },
                },
                async load() { return { title: 'document-only.md', body: '# Fixture\\n\\nNo comment service.', rev: 'opaque-revision-token' }; },
              };
              const ready = new Promise(resolve => fixture.addEventListener('comma-ready', resolve, { once: true }));
              document.body.appendChild(fixture);
              await ready;
              const root = fixture.shadowRoot;
              const result = {
                toolbarActions: Array.from(root.querySelectorAll('[data-toolbar-action]')).map(button => button.dataset.toolbarAction),
                commentCountNodes: root.querySelectorAll('[data-comment-count]').length,
                commentActionNodes: root.querySelectorAll('[data-comment-action]').length,
                sidebarHidden: root.querySelector('[data-el=sidebar]').hidden,
              };
              fixture.remove();
              return result;
            }""")

            document = api("/api/doc?path=paper.md")
            human_created = api("/api/comments", "POST", {
                "path": "paper.md", "kind": "anchored", "actor": "AI Reviewer",
                "content": "Synthetic AI note before the human edit.",
                "quote_text": "Scientific media fixture", "source": "ai-review",
                "source_key": "review-browser:F-HUMAN", "finding_id": "F-HUMAN",
                "finding_state": "accepted",
            })
            human_comment = human_created["comment"]
            human_edited = api(f"/api/comments/{human_comment['id']}", "PATCH", {
                "path": "paper.md", "base_comment_version": human_comment["comment_version"],
                "content": "Synthetic note explicitly edited by a human.", "actor": "June",
            })["comment"]
            withdraw_comment = api("/api/comments", "POST", {
                "path": "paper.md", "kind": "anchored", "actor": "AI Reviewer",
                "content": "Synthetic finding that will be withdrawn.",
                "quote_text": "Validation", "source": "ai-review",
                "source_key": "review-browser:F-WITHDRAW", "finding_id": "F-WITHDRAW",
                "finding_state": "accepted",
            })["comment"]
            preview_store = api("/api/comments?path=paper.md")
            write_slice_c_preview(
                document, preview_store["comments_rev"],
                human_edited["id"], withdraw_comment["id"],
            )
            page.evaluate("""async id => {
              window.__COMMA_REVIEW__.openReviewDrawer();
              await window.__COMMA_REVIEW__.loadReviewSession(id);
            }""", SLICE_C_SESSION_ID)
            page.wait_for_function(
                "document.querySelectorAll('[data-operation-group]').length === 5")
            page.locator("#review-accept-all").click()
            bulk_selected = page.locator("[data-operation-accept]:checked").evaluate_all(
                "nodes => nodes.map(node => node.dataset.operationAccept).sort()")
            human_checkbox = page.locator('.operation-card[data-human-edited="true"] [data-operation-accept]')
            results["operation_preview"] = {
                "groups": page.locator("[data-operation-group]").evaluate_all(
                    "nodes => nodes.map(node => node.dataset.operationGroup)"),
                "counts": page.locator("[data-operation-group] > header b").all_text_contents(),
                "bulkSelected": bulk_selected,
                "humanHighlighted": page.locator('.operation-card[data-human-edited="true"]').count(),
                "humanBulkChecked": human_checkbox.is_checked(),
                "blockedDisabled": page.locator('[data-operation-action="blocked"] [data-operation-accept]').is_disabled(),
                "blockedReason": page.locator('[data-operation-action="blocked"] .operation-reason').text_content(),
            }
            page.set_viewport_size({"width": 700, "height": 900})
            results["operation_preview_narrow"] = page.evaluate("""() => {
              const drawer = document.querySelector('#review-drawer');
              const preview = document.querySelector('.operation-preview');
              const cards = Array.from(document.querySelectorAll('.operation-card'));
              return {
                drawerWidth: drawer.getBoundingClientRect().width,
                drawerScrollWidth: drawer.scrollWidth,
                previewWidth: preview.getBoundingClientRect().width,
                previewScrollWidth: preview.scrollWidth,
                cardOverflow: cards.some(card => card.scrollWidth > card.getBoundingClientRect().width + 1),
              };
            }""")
            page.set_viewport_size({"width": 1400, "height": 900})
            human_checkbox.check()
            page.locator("#review-writeback").click()
            page.wait_for_function(
                "window.__COMMA_REVIEW__.reviewState.activeRun?.status === 'completed'")
            completed_store = api("/api/comments?path=paper.md")
            completed_run = api(f"/api/review-runs/{SLICE_C_RUN_ID}")
            receipt = completed_run["session"]["writeback_receipts"][0]
            results["operation_writeback"] = {
                "status": completed_run["run"]["status"],
                "accepted": completed_run["run"]["accepted_operation_ids"],
                "created": len(receipt["created"]),
                "updated": len(receipt["updated"]),
                "withdrawn": len(receipt["withdrawn"]),
                "kept": len(receipt["kept"]),
                "blocked": len(receipt["blocked"]),
                "humanStillMarked": next(
                    item for item in completed_store["comments"]
                    if item["id"] == human_edited["id"])["human_edited"],
                "withdrawState": next(
                    item for item in completed_store["comments"]
                    if item["id"] == withdraw_comment["id"])["finding_state"],
            }
            page.locator("#review-close").click()
            reset_comments()
            page.evaluate("document.querySelector('comma-editor').refreshComments()")
            page.wait_for_function(
                "document.querySelector('comma-editor').shadowRoot.querySelectorAll('.ce-comment').length === 0")

            page.locator("comma-editor").locator(".ce-preview img").click()
            page.wait_for_function("!document.querySelector('comma-editor').shadowRoot.querySelector('[data-el=lightbox]').hidden")
            results["image_lightbox_opened"] = True
            page.locator("comma-editor").locator("[data-el=lightbox-close]").click()

            document = api("/api/doc?path=paper.md")
            markers = [
                "We present a provenance-aware orchestration layer that coordinates",
                "As shown in Equation for section 3, the inline bound",
                "As shown in Equation for section 9, the inline bound",
                "As shown in Equation for section 14, the inline bound",
                "[13] Author 13, et al.",
            ]
            for index, quote in enumerate(markers):
                api("/api/comments", "POST", {
                    "path": "paper.md",
                    "kind": "anchored",
                    "actor": "TestBot",
                    "content": f"public adapter anchor {index + 1}",
                    "quoteText": quote,
                    "sourceLocator": {"bodyRev": document["rev"], "quoteText": quote},
                })
            page.evaluate("document.querySelector('comma-editor').refreshComments()")
            page.wait_for_function("document.querySelector('comma-editor').shadowRoot.querySelectorAll('.ce-comment').length === 5")
            results["anchors_baseline"] = editor_snapshot(page)

            api("/api/comments", "POST", {
                "path": "paper.md",
                "kind": "overall",
                "actor": "LayoutBot",
                "content": "continuous-scientific-review-token-" * 40,
            })
            page.evaluate("document.querySelector('comma-editor').refreshComments()")
            page.wait_for_function("document.querySelector('comma-editor').shadowRoot.querySelectorAll('.ce-comment').length === 6")
            page.set_viewport_size({"width": 2036, "height": 1143})
            results["scientific_layout"] = page.evaluate("""() => {
              const root = document.querySelector('comma-editor').shadowRoot;
              const sidebar = root.querySelector('.ce-sidebar');
              const comments = root.querySelector('.ce-comments');
              const card = root.querySelector('.ce-comment');
              return {
                sidebarWidth: sidebar.getBoundingClientRect().width,
                sidebarScrollWidth: sidebar.scrollWidth,
                commentsWidth: comments.getBoundingClientRect().width,
                commentsScrollWidth: comments.scrollWidth,
                cardWidth: card.getBoundingClientRect().width,
                cardScrollWidth: card.scrollWidth,
              };
            }""")
            page.set_viewport_size({"width": 700, "height": 900})
            results["narrow_layout"] = page.evaluate("""() => {
              const root = document.querySelector('comma-editor').shadowRoot;
              const shell = root.querySelector('.ce-shell');
              const comments = root.querySelector('.ce-comments');
              const card = root.querySelector('.ce-comment');
              return {
                shellWidth: shell.getBoundingClientRect().width,
                shellScrollWidth: shell.scrollWidth,
                commentsWidth: comments.getBoundingClientRect().width,
                commentsScrollWidth: comments.scrollWidth,
                cardWidth: card.getBoundingClientRect().width,
                cardScrollWidth: card.scrollWidth,
              };
            }""")

            body = read_doc()
            insertion = "\n\nINSERTED-UPSTREAM: " + ("provenance " * 20).strip() + "\n"
            heading = body.index("## 1. Introduction")
            insert_at = body.index("\n", heading) + 1
            edited = body[:insert_at] + insertion + body[insert_at:]
            save = api("/api/doc", "PUT", {
                "path": "paper.md", "body": edited, "base_rev": document["rev"], "actor": "test",
            })
            page.evaluate("document.querySelector('comma-editor').load()")
            page.wait_for_function(
                """rev => document.querySelector('comma-editor').documentState.rev === rev""",
                arg=save["rev"],
            )
            results["anchors_after_upstream_edit"] = editor_snapshot(page)
            results["byte_fidelity"] = read_doc() == edited

            broken = "As shown in Equation for section 9, the inline bound"
            mutated = edited.replace(broken, "As shown in a COMPLETELY REWORDED passage, the bound", 1)
            save2 = api("/api/doc", "PUT", {
                "path": "paper.md", "body": mutated, "base_rev": save["rev"], "actor": "test",
            })
            page.evaluate("document.querySelector('comma-editor').load()")
            page.wait_for_function(
                """rev => document.querySelector('comma-editor').documentState.rev === rev""",
                arg=save2["rev"],
            )
            results["anchors_after_quote_rewrite"] = editor_snapshot(page)
            results["console_errors"] = errors[:10]
            browser.close()
    finally:
        with open(DOC, "w", encoding="utf-8") as handle:
            handle.write(original)
        if os.path.exists(ASSET):
            os.remove(ASSET)
        reset_comments()
        if original_slice_c_session is None:
            if os.path.exists(SLICE_C_SESSION):
                os.remove(SLICE_C_SESSION)
        else:
            with open(SLICE_C_SESSION, "wb") as handle:
                handle.write(original_slice_c_session)

    assert results["public_component_render"]["blocks"] > 100
    assert results["public_component_render"]["katex"] > 0
    assert results["public_component_render"]["images"] == 1
    assert results["public_component_render"]["figures"] == 1
    assert results["public_component_render"]["tableScrolls"] == results["public_component_render"]["tables"]
    assert results["public_component_render"]["imageStates"] == ["ready"]
    assert results["public_component_render"]["theme"] == "scientific"
    assert results["public_component_render"]["shellBackground"] == "rgb(255, 255, 255)"
    assert results["public_component_render"]["paperBackground"] == "rgb(255, 255, 255)"
    assert results["public_component_render"]["textureDisplay"] == "none"
    assert results["image_lightbox_opened"] is True
    assert results["host_actions"]["primary"] == ["文章总览", "AI Review", "全文批注", "批注 0"]
    assert results["host_actions"]["overflow"] == ["源码编辑", "接受全部暂定", "显示已撤回"]
    assert results["host_actions"]["panelTitle"] == "批注"
    assert results["overview_shell"]["title"] == "文章总览"
    assert results["overview_shell"]["claims"] == 3
    assert results["overview_shell"]["revision"] == results["public_component_render"]["rev"]
    assert results["review_preflight"]["title"] == "复审预检"
    assert results["review_preflight"]["route"] in {"FIRST PASS", "NO DELTA", "LOCAL DELTA", "GLOBAL RISK"}
    assert results["review_preflight"]["primary"] in {"开始首次评审", "查看最近评审", "增量复审", "全文复审"}
    assert results["review_preflight"]["claims"] == 3
    assert results["document_only_boundary"] == {
        "toolbarActions": ["document-info"],
        "commentCountNodes": 0,
        "commentActionNodes": 0,
        "sidebarHidden": True,
    }
    assert results["operation_preview"]["groups"] == ["create", "update", "withdraw", "keep", "blocked"]
    assert results["operation_preview"]["counts"] == ["1", "1", "1", "1", "1"]
    assert results["operation_preview"]["bulkSelected"] == ["op-create", "op-keep", "op-withdraw"]
    assert results["operation_preview"]["humanHighlighted"] == 1
    assert results["operation_preview"]["humanBulkChecked"] is False
    assert results["operation_preview"]["blockedDisabled"] is True
    assert "anchor is ambiguous" in results["operation_preview"]["blockedReason"]
    assert results["operation_preview_narrow"]["drawerScrollWidth"] <= results["operation_preview_narrow"]["drawerWidth"] + 1
    assert results["operation_preview_narrow"]["previewScrollWidth"] <= results["operation_preview_narrow"]["previewWidth"] + 1
    assert results["operation_preview_narrow"]["cardOverflow"] is False
    assert results["operation_writeback"] == {
        "status": "completed",
        "accepted": ["op-create", "op-human", "op-withdraw", "op-keep"],
        "created": 1,
        "updated": 1,
        "withdrawn": 1,
        "kept": 1,
        "blocked": 1,
        "humanStillMarked": True,
        "withdrawState": "withdrawn",
    }
    assert results["scientific_layout"]["commentsScrollWidth"] <= results["scientific_layout"]["commentsWidth"] + 1
    assert results["scientific_layout"]["cardScrollWidth"] <= results["scientific_layout"]["cardWidth"] + 1
    assert results["narrow_layout"]["shellScrollWidth"] <= results["narrow_layout"]["shellWidth"] + 1
    assert results["narrow_layout"]["commentsScrollWidth"] <= results["narrow_layout"]["commentsWidth"] + 1
    assert results["narrow_layout"]["cardScrollWidth"] <= results["narrow_layout"]["cardWidth"] + 1
    assert results["anchors_baseline"]["resolved"] == 5
    assert results["anchors_after_upstream_edit"]["resolved"] == 5
    assert results["anchors_after_quote_rewrite"]["stale"] == 1
    assert results["byte_fidelity"] is True
    assert not results["console_errors"], results["console_errors"]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
