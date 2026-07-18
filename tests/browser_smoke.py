#!/usr/bin/env python3
"""Headless browser acceptance check for the standalone host."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PORT = 4178
URL = f"http://127.0.0.1:{PORT}/standalone/"


def wait_ready() -> None:
    for _ in range(80):
        try:
            with urlopen(URL, timeout=0.4) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Vite server did not become ready")


def main() -> None:
    server = subprocess.Popen(
        ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_ready()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
            page.add_init_script("localStorage.clear()")
            page.goto(URL, wait_until="networkidle")
            page.wait_for_function("document.querySelector('comma-editor')?.shadowRoot?.querySelectorAll('.ce-block').length > 3")
            title = page.locator("comma-editor").evaluate("el => el.shadowRoot.querySelector('[data-el=title]').textContent")
            blocks = page.locator("comma-editor").evaluate("el => el.shadowRoot.querySelectorAll('.ce-block').length")

            page.locator("comma-editor").evaluate(
                """el => {
                  el.selectionActions = [
                    { id: 'quick-explain', label: 'Quick explain' },
                    { id: 'discuss', label: 'Discuss' }
                  ];
                  window.__selectionAction = null;
                  el.addEventListener('comma-selection-action', event => {
                    window.__selectionAction = {
                      actionId: event.detail.actionId,
                      quoteText: event.detail.quoteText,
                      rev: event.detail.document.rev
                    };
                  });
                }"""
            )

            # Select a whole rendered paragraph that crosses ** markers in the
            # raw source. The component must use rendered-block fallback.
            page.locator("comma-editor").evaluate(
                """el => {
                  const paragraph = el.shadowRoot.querySelector('.ce-block p');
                  const range = document.createRange();
                  range.selectNodeContents(paragraph);
                  const selection = getSelection();
                  selection.removeAllRanges();
                  selection.addRange(range);
                  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                }"""
            )
            page.wait_for_function("!document.querySelector('comma-editor').shadowRoot.querySelector('[data-el=selection-bar]').hidden")
            selection_actions = page.locator("comma-editor").evaluate(
                "el => Array.from(el.shadowRoot.querySelectorAll('[data-selection-action]')).map(button => button.textContent)"
            )
            page.locator("comma-editor").evaluate(
                "el => el.shadowRoot.querySelector('[data-selection-action=quick-explain]').click()"
            )
            page.wait_for_function("window.__selectionAction?.actionId === 'quick-explain'")
            selection_event = page.evaluate("window.__selectionAction")
            assert selection_actions == ["Quick explain", "Discuss"]
            assert selection_event["actionId"] == "quick-explain"
            assert selection_event["quoteText"]
            assert selection_event["rev"]

            # Re-select after the host action consumes the quote, then create a
            # native comment through the editor-owned action.
            page.locator("comma-editor").evaluate(
                """el => {
                  const paragraph = el.shadowRoot.querySelector('.ce-block p');
                  const range = document.createRange();
                  range.selectNodeContents(paragraph);
                  const selection = getSelection();
                  selection.removeAllRanges();
                  selection.addRange(range);
                  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                }"""
            )
            page.wait_for_function("!document.querySelector('comma-editor').shadowRoot.querySelector('[data-el=selection-bar]').hidden")
            page.locator("comma-editor").evaluate("el => el.shadowRoot.querySelector('[data-action=selection-comment]').click()")
            page.locator("comma-editor").evaluate(
                "el => { el.shadowRoot.querySelector('[data-el=comment-input]').value = 'Keep this as the core invariant.'; }"
            )
            page.locator("comma-editor").evaluate("el => el.shadowRoot.querySelector('[data-action=save-comment]').click()")
            page.wait_for_function("document.querySelector('comma-editor').shadowRoot.querySelector('[data-el=comment-count]').textContent === '1'")
            anchor_state = page.locator("comma-editor").evaluate(
                "el => el.shadowRoot.querySelector('.ce-comment-state').textContent"
            )

            # Feed a host-produced structured review into the public SDK API.
            # One exact quote is eligible; one missing quote must stay blocked.
            batch_preview = page.locator("comma-editor").evaluate(
                """el => el.previewCommentBatch({
                  base_rev: el.documentState.rev,
                  comments: [
                    {
                      quote_text: 'A mature component is defined by its boundary, not by the number of buttons it contains.',
                      content: 'Keep this as the acceptance criterion.',
                      priority: 'P1',
                      section: 'The small contract'
                    },
                    {
                      quote_text: 'This sentence does not exist.',
                      content: 'This proposal must never be written.'
                    }
                  ]
                }, { actor: 'browser-smoke-ai', source: 'test-review' })"""
            )
            assert batch_preview["counts"]["ready"] == 1
            assert batch_preview["counts"]["missing"] == 1
            page.wait_for_timeout(260)
            review_screenshot = ROOT / "test-artifacts" / "review-queue.png"
            review_screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(review_screenshot), full_page=False)
            page.locator("comma-editor").evaluate(
                "el => el.shadowRoot.querySelector('[data-action=apply-review]').click()"
            )
            page.wait_for_function(
                "document.querySelector('comma-editor').shadowRoot.querySelector('[data-el=comment-count]').textContent === '2'"
            )
            review_queue_closed = page.locator("comma-editor").evaluate(
                "el => el.shadowRoot.querySelector('[data-el=review-queue]').hidden"
            )

            # Exercise in-place block editing before whole-source editing.
            page.locator("comma-editor").evaluate(
                "el => el.shadowRoot.querySelector('[data-block-type=paragraph]').click()"
            )
            page.wait_for_function("document.querySelector('comma-editor').shadowRoot.querySelector('.ce-block-editor')")
            page.locator("comma-editor").evaluate(
                """el => {
                  const ta = el.shadowRoot.querySelector('.ce-block-editor');
                  ta.value += ' Block edit.';
                  ta.dispatchEvent(new Event('blur'));
                }"""
            )
            page.wait_for_function("document.querySelector('comma-editor').documentState.body.includes('Block edit.')")

            page.locator("comma-editor").evaluate("el => el.shadowRoot.querySelector('[data-action=source]').click()")
            page.locator("comma-editor").evaluate(
                "el => { const ta = el.shadowRoot.querySelector('[data-el=source-editor]'); ta.value += '\\nBrowser smoke edit.\\n'; }"
            )
            page.locator("comma-editor").evaluate("el => el.shadowRoot.querySelector('[data-action=save-source]').click()")
            page.wait_for_function("document.querySelector('comma-editor').documentState.body.includes('Browser smoke edit.')")
            screenshot = ROOT / "test-artifacts" / "standalone.png"
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshot), full_page=True)
            result = {
                "ok": True,
                "title": title,
                "blocks": blocks,
                "selection_actions": selection_actions,
                "selection_event": selection_event,
                "anchor_state": anchor_state,
                "batch_ready": batch_preview["counts"]["ready"],
                "batch_missing": batch_preview["counts"]["missing"],
                "review_queue_closed": review_queue_closed,
                "review_screenshot": str(review_screenshot),
                "screenshot": str(screenshot),
            }
            (ROOT / "test-artifacts" / "browser-smoke.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(json.dumps(result, ensure_ascii=False))
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=4)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    main()
