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


if __name__ == "__main__":
    unittest.main()
