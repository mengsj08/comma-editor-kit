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
    assert results["host_actions"]["overflow"] == ["源码编辑", "显示已撤回"]
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
