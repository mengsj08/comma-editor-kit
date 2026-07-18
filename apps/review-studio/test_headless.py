#!/usr/bin/env python3
"""Headless verification for Comma Review Studio. Run with the kanban venv python
(has playwright+chromium). Measures the four unknowns and prints falsifiable
numbers. Assumes server.py is already running on COMMA_REVIEW_PORT (default 8891).
"""
import json
import os
import statistics
import time
import urllib.request

from playwright.sync_api import sync_playwright

PORT = os.environ.get("COMMA_REVIEW_PORT", os.environ.get("SPIKE_PORT", "8891"))
BASE = f"http://127.0.0.1:{PORT}"
URL = f"{BASE}/?doc=paper.md"
ROOT = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(ROOT, "data", "paper.md")


def api(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def reset_comments():
    p = DOC + ".comments.json"
    if os.path.exists(p):
        os.remove(p)


def read_doc():
    with open(DOC, encoding="utf-8") as f:
        return f.read()


results = {}


def main():
    reset_comments()
    original_body = read_doc()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})

        # ---- (a) first render ----
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        t0 = time.time()
        page.goto(URL, wait_until="load")
        page.wait_for_selector("#detail-md-content h2", timeout=15000)
        page.wait_for_selector(".katex", timeout=15000)
        t_full = (time.time() - t0) * 1000
        # isolated re-render (parse+katex+DOM, excludes CDN download)
        samples = []
        for _ in range(5):
            dt = page.evaluate("""() => {
              const c = window.__SPIKE__.ctx;
              const t0 = performance.now();
              c.markdown.renderMarkdownEnhanced(c.el.detailMdContent, c.uiState.detail.currentTaskBody, 'paper.md', {});
              return performance.now() - t0;
            }""")
            samples.append(dt)
        counts = page.evaluate("""() => ({
          blocks: document.querySelectorAll('#detail-md-content p,li,h1,h2,h3,td,th,pre').length,
          katex: document.querySelectorAll('#detail-md-content .katex').length,
          katexErr: document.querySelectorAll('#detail-md-content .katex-error').length,
          tables: document.querySelectorAll('#detail-md-content table').length,
          code: document.querySelectorAll('#detail-md-content pre code').length,
        })""")
        results["render"] = {
            "full_load_ms": round(t_full),
            "isolated_rerender_ms_median": round(statistics.median(samples)),
            "isolated_rerender_ms_all": [round(x) for x in samples],
            "dom": counts,
            "console_errors": errors[:10],
        }

        # ---- (c) anchor creation (>=5) via the FAITHFUL UI path ----
        # For each unique marker substring, find the rendered block, build a real
        # DOM Range over it, and call sourceQuoteFromSelection(text, range) exactly
        # like the browser selection flow (this populates block_index too).
        quotes = page.evaluate("""() => {
          const c = window.__SPIKE__.ctx;
          const body = c.uiState.detail.currentTaskBody;
          // unique spans: abstract + per-section 'As shown in Equation for section N' + a reference line
          const markers = [
            'We present a provenance-aware orchestration layer that coordinates',
            'As shown in Equation for section 3, the inline bound',
            'As shown in Equation for section 9, the inline bound',
            'As shown in Equation for section 14, the inline bound',
            '[13] Author 13, et al.',
          ];
          const blocks = c.anchor.bodyQuoteBlocks();
          return markers.map((mk) => {
            const occ = (body.match(new RegExp(mk.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g')) || []).length;
            const block = blocks.find((b) => (b.textContent || '').includes(mk));
            let sq = null;
            if (block) {
              const range = document.createRange();
              range.selectNodeContents(block);
              const text = String(block.textContent || '').trim();
              sq = c.anchor.sourceQuoteFromSelection(text.slice(0, 2000), range);
            }
            return { q: mk, occurrences_in_body: occ, hasBlock: !!block, sq };
          });
        }""")
        created = []
        for item in quotes:
            sq = item["sq"]
            if not sq:
                created.append({"hasBlock": False, "occurrences": item["occurrences_in_body"]})
                continue
            api("/api/comments", "POST", {
                "path": "paper.md", "author": "TestBot",
                "content": "anchor test on: " + item["q"][:30],
                "quote_text": sq["quote_text"], "section": sq["section"],
                "source_locator": sq["source_locator"],
            })
            created.append({"hasBlock": item["hasBlock"], "occurrences": item["occurrences_in_body"],
                            "block_index": sq["source_locator"]["block_index"],
                            "text_index": sq["source_locator"]["text_index"]})
        # baseline resolution
        page.evaluate("() => window.__SPIKE__.loadComments()")
        page.wait_for_timeout(300)
        baseline = page.evaluate("""() => window.__SPIKE__.comments.map((c) => ({
          id: c.id, resolved: c._resolved,
          block: c._resolved ? null : null,
        }))""")
        # verify each resolves to a block actually containing its quote
        baseline_acc = page.evaluate("""() => {
          const c = window.__SPIKE__.ctx;
          return window.__SPIKE__.comments.map((cm) => {
            const t = c.anchor.resolveBodyQuoteTarget(cm);
            const norm = (s) => String(s||'').replace(/\\s+/g,' ').trim();
            return { resolved: !!t, correct: !!t && norm(t.textContent).includes(norm(cm.quote_text).slice(0,40)) };
          });
        }""")
        results["anchors_baseline"] = {
            "created": len(created),
            "created_detail": created,
            "per_anchor": baseline_acc,
            "resolved": sum(1 for a in baseline_acc if a["resolved"]),
            "correct": sum(1 for a in baseline_acc if a["correct"]),
        }

        # ---- (b)+(c) edit upstream: insert + delete paragraph above all anchors ----
        body = read_doc()
        # insert a big new paragraph right after the first "## 1. Introduction"
        marker = "\n\nINSERTED-UPSTREAM: " + ("provenance " * 20).strip() + "\n"
        anchor_pt = body.index("## 1. Introduction")
        insert_at = body.index("\n", anchor_pt) + 1
        edited = body[:insert_at] + marker + body[insert_at:]
        # delete an upstream paragraph (the abstract blockquote line region): remove one filler line
        del_target = "We now examine introduction in the context of reproducible multi-agent pipelines."
        if del_target in edited:
            edited = edited.replace(del_target + "\n\n", "", 1)
        rev = api("/api/doc?path=paper.md")["rev"]
        save = api("/api/doc", "PUT", {"path": "paper.md", "body": edited, "base_rev": rev, "actor": "june"})
        # byte-fidelity check: reread equals what we saved
        roundtrip_ok = read_doc() == edited
        # reload doc in browser and re-resolve anchors
        page.evaluate("""async () => {
          const c = window.__SPIKE__.ctx; const st = c.uiState.detail;
          const j = await (await fetch('/api/doc?path=paper.md')).json();
          st.currentTaskBody = j.body; st.savedBodyContent = j.body; st.currentTaskRev = j.rev;
          c.markdown.renderMarkdownEnhanced(c.el.detailMdContent, j.body, 'paper.md', {});
          await window.__SPIKE__.loadComments();
        }""")
        page.wait_for_timeout(400)
        after_edit = page.evaluate("""() => {
          const c = window.__SPIKE__.ctx;
          const norm = (s) => String(s||'').replace(/\\s+/g,' ').trim();
          return window.__SPIKE__.comments.map((cm) => {
            const t = c.anchor.resolveBodyQuoteTarget(cm);
            return { resolved: !!t, correct: !!t && norm(t.textContent).includes(norm(cm.quote_text).slice(0,40)) };
          });
        }""")
        results["edit_roundtrip"] = {
            "save_ok": save.get("ok"),
            "byte_fidelity_after_reread": roundtrip_ok,
            "new_rev_differs": save.get("rev") != rev,
        }
        results["anchors_after_upstream_edit"] = {
            "resolved": sum(1 for a in after_edit if a["resolved"]),
            "correct": sum(1 for a in after_edit if a["correct"]),
            "total": len(after_edit),
            "per_anchor": after_edit,
        }

        # ---- failure mode: mutate a quoted span -> that anchor should go stale ----
        body2 = read_doc()
        broken_quote = "As shown in Equation for section 9, the inline bound"
        mutated = body2.replace(broken_quote, "As shown in a COMPLETELY REWORDED passage, the bound", 1)
        rev2 = api("/api/doc?path=paper.md")["rev"]
        api("/api/doc", "PUT", {"path": "paper.md", "body": mutated, "base_rev": rev2, "actor": "june"})
        page.evaluate("""async () => {
          const c = window.__SPIKE__.ctx; const st = c.uiState.detail;
          const j = await (await fetch('/api/doc?path=paper.md')).json();
          st.currentTaskBody = j.body; st.currentTaskRev = j.rev;
          c.markdown.renderMarkdownEnhanced(c.el.detailMdContent, j.body, 'paper.md', {});
          await window.__SPIKE__.loadComments();
        }""")
        page.wait_for_timeout(300)
        after_break = page.evaluate("""() => {
          const c = window.__SPIKE__.ctx;
          return window.__SPIKE__.comments.map((cm) => ({ q: cm.quote_text.slice(0,40), resolved: !!c.anchor.resolveBodyQuoteTarget(cm) }));
        }""")
        results["anchors_failure_mode"] = {
            "note": "reworded 1 quoted span; that anchor must go unresolved, others stay",
            "per_anchor": after_break,
            "went_stale": sum(1 for a in after_break if not a["resolved"]),
        }

        # ---- KaTeX spot check ----
        katex_sample = page.evaluate("""() => {
          const el = document.querySelector('#detail-md-content .katex');
          return { hasKatex: !!el, sampleText: el ? el.textContent.slice(0,40) : '' };
        }""")
        results["katex"] = {
            "rendered_count": counts["katex"],
            "error_count": counts["katexErr"],
            "sample": katex_sample,
        }

        browser.close()

    # restore original doc + clear comments so the artifact is reproducible
    with open(DOC, "w", encoding="utf-8") as f:
        f.write(original_body)
    reset_comments()

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
