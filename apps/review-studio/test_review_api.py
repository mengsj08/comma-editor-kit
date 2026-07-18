#!/usr/bin/env python3
"""HTTP-level contract test with a controlled AI response."""
import json
import os
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest import mock

import server


class ReviewApiTests(unittest.TestCase):
    def test_document_relative_assets_are_served_and_confined(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = os.path.realpath(raw_tmp)
            nested = os.path.join(tmp, "nested")
            figures = os.path.join(nested, "figures")
            os.makedirs(figures)
            with open(os.path.join(nested, "paper.md"), "w", encoding="utf-8") as fh:
                fh.write("![Control](figures/control.png)\n")
            payload = b"\x89PNG\r\n\x1a\ncontrolled-test-image"
            with open(os.path.join(figures, "control.png"), "wb") as fh:
                fh.write(payload)
            with mock.patch.object(server, "DATA_ROOT", tmp):
                httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{httpd.server_address[1]}"
                try:
                    with urllib.request.urlopen(
                        base + "/api/asset?doc=nested%2Fpaper.md&source=figures%2Fcontrol.png"
                    ) as response:
                        self.assertEqual(response.headers.get_content_type(), "image/png")
                        self.assertEqual(response.read(), payload)
                    escaped = self._request_error(
                        base + "/api/asset?doc=nested%2Fpaper.md&source=..%2F..%2Foutside.png"
                    )
                    self.assertEqual(escaped[0], 400)
                    self.assertIn("escapes data root", escaped[1]["error"])
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(timeout=2)

    def test_public_comment_contract_and_atomic_batch_revision(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = os.path.realpath(raw_tmp)
            body = "# Results\n\nA precise sentence for an anchored comment.\n"
            with open(os.path.join(tmp, "paper.md"), "w", encoding="utf-8") as fh:
                fh.write(body)
            with mock.patch.object(server, "DATA_ROOT", tmp), \
                    mock.patch.object(server, "EVENTS_PATH", os.path.join(tmp, "events.jsonl")):
                httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{httpd.server_address[1]}"
                try:
                    document = self._request(base + "/api/doc?path=paper.md")
                    overall = self._request(base + "/api/comments?path=paper.md", "POST", {
                        "kind": "overall", "actor": "June", "content": "整体意见",
                    })
                    self.assertEqual(overall["comment"]["kind"], "overall")
                    self.assertEqual(overall["comment"]["author"], "June")
                    batch = self._request(base + "/api/comments/batch?path=paper.md", "POST", {
                        "baseRev": document["rev"],
                        "actor": "AI Reviewer",
                        "source": "contract-test",
                        "comments": [{
                            "kind": "anchored",
                            "quoteText": "A precise sentence for an anchored comment.",
                            "content": "请补来源",
                            "priority": "P1",
                            "sourceLocator": {"bodyRev": document["rev"]},
                        }],
                    })
                    self.assertEqual(len(batch["comments"]), 1)
                    self.assertEqual(batch["comments"][0]["source"], "contract-test")
                    self.assertEqual(batch["comments"][0]["quote_text"], "A precise sentence for an anchored comment.")

                    conflict = self._request_error(base + "/api/comments/batch?path=paper.md", "POST", {
                        "base_rev": "sha256-stale",
                        "comments": [{"kind": "overall", "content": "不应写入"}],
                    })
                    self.assertEqual(conflict[0], 409)
                    self.assertTrue(conflict[1]["conflict"])
                    comments = self._request(base + "/api/comments?path=paper.md")
                    self.assertEqual(len(comments["comments"]), 2)
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(timeout=2)

    def test_review_discussion_and_incremental_writeback(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = os.path.realpath(raw_tmp)
            body = "# Results\n\nThis tiny cohort proves broad clinical utility.\n"
            with open(os.path.join(tmp, "paper.md"), "w", encoding="utf-8") as fh:
                fh.write(body)
            initial = {
                "tool": "claude", "returncode": 0, "elapsed_ms": 12,
                "output": json.dumps({
                    "summary": "证据边界需要收紧。",
                    "assistant_text": "已生成一条主要问题。",
                    "findings": [{
                        "id": "F001", "section": "Results",
                        "quote_text": "This tiny cohort proves broad clinical utility.",
                        "issue": "样本量不足以支持广泛临床外推。",
                        "action": "改为探索性结果并说明样本限制。", "priority": "P1",
                    }],
                }, ensure_ascii=False),
            }
            continued = {
                "tool": "claude", "returncode": 0, "elapsed_ms": 9,
                "output": json.dumps({
                    "assistant_text": "已把建议改为同时要求补充验证队列。",
                    "finding_ops": [{
                        "op": "update", "finding_id": "F001",
                        "patch": {"action": "改为探索性结果，并补充独立验证队列。"},
                    }],
                }, ensure_ascii=False),
            }
            review_root = os.path.join(tmp, "review-sessions")
            events = os.path.join(tmp, "events.jsonl")
            with mock.patch.object(server, "DATA_ROOT", tmp), \
                    mock.patch.object(server, "REVIEW_ROOT", review_root), \
                    mock.patch.object(server, "EVENTS_PATH", events), \
                    mock.patch.object(server, "_invoke_ai", side_effect=[initial, continued]):
                httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{httpd.server_address[1]}"
                try:
                    started = self._request(base + "/api/review-sessions", "POST", {
                        "path": "paper.md", "tool": "claude", "writeback_policy": "auto-ready",
                    })
                    self.assertTrue(started["ok"])
                    self.assertEqual(len(started["writeback"]["created"]), 1)
                    session_id = started["session"]["id"]

                    updated = self._request(
                        base + f"/api/review-sessions/{session_id}/messages", "POST",
                        {"message": "把建议补充为还需要独立验证队列。"},
                    )
                    self.assertTrue(updated["ok"])
                    self.assertEqual(len(updated["writeback"]["updated"]), 1)
                    self.assertEqual(len(updated["session"]["messages"]), 3)

                    comments = self._request(base + "/api/comments?path=paper.md")
                    self.assertEqual(len(comments["comments"]), 1)
                    self.assertIn("独立验证队列", comments["comments"][0]["content"])
                    sessions = self._request(base + "/api/review-sessions?path=paper.md")
                    self.assertEqual(sessions["sessions"][0]["applied_count"], 1)
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(timeout=2)

    def test_quote_conversation_branch_note_and_explicit_writeback(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = os.path.realpath(raw_tmp)
            body = "# Results\n\nThis tiny cohort suggests a preliminary response.\n"
            with open(os.path.join(tmp, "paper.md"), "w", encoding="utf-8") as fh:
                fh.write(body)
            responses = [
                {"tool": "codex", "returncode": 0, "elapsed_ms": 6,
                 "output": "这句话只支持探索性信号，不能外推疗效。"},
                {"tool": "codex", "returncode": 0, "elapsed_ms": 7,
                 "output": "在该分支假设下，还需要独立队列和预设终点。"},
            ]
            conversation_root = os.path.join(tmp, "conversations")
            events = os.path.join(tmp, "events.jsonl")
            with mock.patch.object(server, "DATA_ROOT", tmp), \
                    mock.patch.object(server, "CONVERSATION_ROOT", conversation_root), \
                    mock.patch.object(server, "EVENTS_PATH", events), \
                    mock.patch.object(server, "_invoke_ai", side_effect=responses):
                httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{httpd.server_address[1]}"
                try:
                    document = self._request(base + "/api/doc?path=paper.md")
                    started = self._request(base + "/api/conversations", "POST", {
                        "path": "paper.md", "base_rev": document["rev"], "tool": "codex",
                        "source_quote": {
                            "quote_text": "This tiny cohort suggests a preliminary response.",
                            "source_locator": {"text_index": body.index("This tiny cohort")},
                        },
                        "message": "这句话能支持什么结论？",
                    })
                    session_id = started["session"]["id"]
                    assistant_id = started["session"]["messages"][-1]["id"]
                    noted = self._request(base + f"/api/conversations/{session_id}/notes", "POST", {
                        "parent_message_id": assistant_id, "content": "这个边界判断保留。",
                    })
                    self.assertEqual(noted["note"]["role"], "note")

                    forked = self._request(base + f"/api/conversations/{session_id}/messages", "POST", {
                        "parent_message_id": assistant_id, "mode": "fork",
                        "message": "如果把它作为探索性终点呢？",
                    })
                    self.assertTrue(forked["branch_created"])
                    branch_messages = [m for m in forked["session"]["messages"] if m.get("branch_id") != "main"]
                    self.assertEqual(len(branch_messages), 2)
                    self.assertEqual(branch_messages[0]["branch_from_message_id"], assistant_id)

                    written = self._request(base + f"/api/conversations/{session_id}/writeback", "POST", {
                        "message_id": assistant_id,
                        "content": "证据边界：仅支持探索性信号，不能直接外推疗效。",
                    })
                    self.assertEqual(written["action"], "created")
                    repeated = self._request(base + f"/api/conversations/{session_id}/writeback", "POST", {
                        "message_id": assistant_id,
                        "content": "证据边界：仅支持探索性信号，不能直接外推疗效。",
                    })
                    self.assertEqual(repeated["action"], "skipped")
                    comments = self._request(base + "/api/comments?path=paper.md")["comments"]
                    self.assertEqual(len(comments), 1)
                    self.assertEqual(comments[0]["conversation_session_id"], session_id)

                    sessions = self._request(base + "/api/conversations?path=paper.md")["sessions"]
                    self.assertEqual(sessions[0]["branch_count"], 1)
                    self.assertEqual(sessions[0]["message_count"], 5)

                    with open(os.path.join(tmp, "paper.md"), "a", encoding="utf-8") as fh:
                        fh.write("\nChanged.\n")
                    conflict = self._request_error(
                        base + f"/api/conversations/{session_id}/writeback", "POST",
                        {"message_id": branch_messages[-1]["id"]},
                    )
                    self.assertEqual(conflict[0], 409)
                    self.assertTrue(conflict[1]["conflict"])
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(timeout=2)

    @staticmethod
    def _request(url, method="GET", payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8")
            raise AssertionError(f"HTTP {exc.code}: {detail}") from exc

    @staticmethod
    def _request_error(url, method="GET", payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read().decode("utf-8"))
            finally:
                exc.close()
        raise AssertionError("request unexpectedly succeeded")


if __name__ == "__main__":
    unittest.main()
