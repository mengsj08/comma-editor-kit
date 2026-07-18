#!/usr/bin/env python3
"""Headless verification for SKL-20 round-2: block-level in-place editing.

Run with the kanban venv python (playwright+chromium). Assumes server.py is
running on COMMA_REVIEW_PORT (default 8891). Proves:
  1. marked.lexer token.raw reconstructs the source exactly (offset math sound).
  2. Click a block -> textarea; edit -> blur/commit -> GET doc shows ONLY that
     block's byte range changed (every other byte identical = provenance).
  3. A comment anchored on an edited block goes stale WITHOUT any JS error.

Restores the document + clears comments at the end so the artifact is clean.
"""
import json
import os
import re
import time

from playwright.sync_api import sync_playwright

PORT = os.environ.get("COMMA_REVIEW_PORT", os.environ.get("SPIKE_PORT", "8891"))
BASE = f"http://127.0.0.1:{PORT}"
URL = f"{BASE}/?doc=paper.md"
ROOT = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(ROOT, "data", "paper.md")


def read_doc():
    with open(DOC, encoding="utf-8") as f:
        return f.read()


def reset_comments():
    p = DOC + ".comments.json"
    if os.path.exists(p):
        os.remove(p)


results = {}


def main():
    reset_comments()
    original = read_doc()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        page.goto(URL, wait_until="load")
        page.wait_for_selector(".doc-block")
        page.wait_for_selector(".katex", timeout=15000)

        # ---- 1. lexer reconstruction (offset math is exact) ----
        recon = page.evaluate("""() => {
          const body = window.__SPIKE__.ctx.uiState.detail.currentTaskBody;
          const toks = window.marked.lexer(body);
          const cat = toks.map(t => t.raw || '').join('');
          return { equal: cat === body, tokenCount: toks.length,
                   blockCount: window.__SPIKE__.blockMap.length,
                   bodyLen: body.length, catLen: cat.length };
        }""")
        results["lexer_reconstruction"] = recon

        # ---- 2. click a block -> enters edit (real click path) ----
        click_edit = page.evaluate("""() => {
          const S = window.__SPIKE__;
          const bm = S.blockMap;
          const cand = bm.filter(b => b.type === 'paragraph');
          const b = cand[Math.floor(cand.length / 2)];
          const wrap = document.querySelector('[data-block-index="' + b.index + '"]');
          wrap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const active = !!(S.activeBlockEditor && S.activeBlockEditor.block.index === b.index);
          // cancel this one so the measured edit below is clean
          if (S.activeBlockEditor) S.commitBlockEdit(true);
          return { picked_index: b.index, entered_edit_on_click: active };
        }""")
        results["click_to_edit"] = click_edit

        # capture the picked block's source range BEFORE editing
        pick = page.evaluate("""(idx) => {
          const b = window.__SPIKE__.blockMap.find(x => x.index === idx);
          return { index: b.index, start: b.start, end: b.end, raw: b.raw, type: b.type };
        }""", click_edit["picked_index"])

        # ---- perform the edit through the real UI path and commit (blur-equivalent) ----
        page.evaluate("""async (bidx) => {
          const S = window.__SPIKE__;
          const wrap = document.querySelector('[data-block-index="' + bidx + '"]');
          S.enterBlockEdit(wrap);
          const ta = S.activeBlockEditor.ta;
          ta.value = ta.value + ' EDITED-BY-TEST';
          await S.commitBlockEdit(false);   // same path as blur
        }""", pick["index"])
        page.wait_for_timeout(400)

        after = read_doc()
        raw = pick["raw"]
        trailer = re.search(r"\n*$", raw).group(0)
        content = raw[: len(raw) - len(trailer)]
        new_raw = content + " EDITED-BY-TEST" + trailer
        expected = original[: pick["start"]] + new_raw + original[pick["end"]:]
        orig_suffix = original[pick["end"]:]
        results["byte_fidelity"] = {
            "block_index": pick["index"],
            "block_type": pick["type"],
            "edit_applied": (" EDITED-BY-TEST" in after),
            "only_this_block_changed": (after == expected),
            "prefix_bytes_identical": original[: pick["start"]] == after[: pick["start"]],
            "suffix_bytes_identical": orig_suffix == after[len(after) - len(orig_suffix):],
            "chars_before": len(original), "chars_after": len(after),
            "delta_chars": len(after) - len(original),
        }

        # ---- 3. comment on a block -> edit that block -> anchor goes stale, no JS error ----
        # restore doc first for a clean anchor test
        page.evaluate("""async () => {
          const j = await (await fetch('/api/doc?path=paper.md')).json();
          return j.rev;
        }""")
        stale = page.evaluate("""async () => {
          const S = window.__SPIKE__; const c = S.ctx;
          // pick a unique paragraph, anchor a comment to its full text
          const b = S.blockMap.filter(x => x.type === 'paragraph')
                    .find(x => (x.raw||'').includes('We present a provenance-aware'))
                 || S.blockMap.filter(x => x.type === 'paragraph')[3];
          const wrap = document.querySelector('[data-block-index="' + b.index + '"]');
          const el = wrap.querySelector('p') || wrap;
          const range = document.createRange(); range.selectNodeContents(el);
          const sq = c.anchor.sourceQuoteFromSelection(String(el.textContent||'').trim().slice(0,300), range);
          const r = await fetch('/api/comments', { method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ path:'paper.md', author:'TestBot', content:'stale test',
              quote_text: sq.quote_text, section: sq.section, source_locator: sq.source_locator }) });
          await window.__SPIKE__.loadComments();
          const before = window.__SPIKE__.comments.map(x => ({ id:x.id, resolved:x._resolved }));
          // now heavily edit that block so the quote no longer matches
          S.enterBlockEdit(wrap);
          S.activeBlockEditor.ta.value = 'This paragraph has been COMPLETELY rewritten so the old quote is gone.';
          await S.commitBlockEdit(false);
          await window.__SPIKE__.loadComments();
          const afterc = window.__SPIKE__.comments.map(x => ({ id:x.id, resolved:x._resolved }));
          return { block_index: b.index, before, after: afterc };
        }""")
        page.wait_for_timeout(300)
        results["comment_on_edited_block"] = {
            "detail": stale,
            "went_stale": all(a["resolved"] is False for a in stale["after"]) if stale["after"] else None,
            "was_resolved_before": all(a["resolved"] for a in stale["before"]) if stale["before"] else None,
        }

        results["console_errors"] = errors[:10]
        browser.close()

    # restore original doc + clear comments
    with open(DOC, "w", encoding="utf-8") as f:
        f.write(original)
    reset_comments()
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
