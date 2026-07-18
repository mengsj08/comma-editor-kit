#!/usr/bin/env python3
"""Browser acceptance for the canonical <comma-editor> Review Studio surface.

Run with the kanban Playwright venv. The server must already be running on
COMMA_REVIEW_PORT (default 8891). The fixture is restored on exit.
"""
import json
import os
import time
import urllib.request

from playwright.sync_api import sync_playwright

PORT = os.environ.get("COMMA_REVIEW_PORT", "8891")
BASE = f"http://127.0.0.1:{PORT}"
URL = f"{BASE}/?doc=paper.md"
ROOT = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(ROOT, "data", "paper.md")
COMMENTS = DOC + ".comments.json"


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
    if os.path.exists(COMMENTS):
        os.remove(COMMENTS)


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
        code: root.querySelectorAll('pre code').length,
        comments: root.querySelectorAll('.ce-comment').length,
        resolved: resolutions.filter(item => Number.isInteger(item.blockIndex) && item.blockIndex >= 0).length,
        stale: resolutions.filter(item => item.state === 'missing').length,
        ambiguous: resolutions.filter(item => item.state === 'ambiguous').length,
        resolutionStates: resolutions.map(item => item.state),
      };
    }""")


def main():
    reset_comments()
    original = read_doc()
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
        reset_comments()

    assert results["public_component_render"]["blocks"] > 100
    assert results["public_component_render"]["katex"] > 0
    assert results["anchors_baseline"]["resolved"] == 5
    assert results["anchors_after_upstream_edit"]["resolved"] == 5
    assert results["anchors_after_quote_rewrite"]["stale"] == 1
    assert results["byte_fidelity"] is True
    assert not results["console_errors"], results["console_errors"]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
