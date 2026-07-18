import {
  HttpDocumentAdapter,
  normalizeReviewSession,
  registerCommaEditor,
} from '/comma-kit/comma-editor.js';

registerCommaEditor();

const DOC_PATH = new URLSearchParams(location.search).get('doc') || 'paper.md';
const $ = (id) => document.getElementById(id);
const editor = $('comma-editor');
const reviewState = { active: null, sessions: [], running: false };
let toastTimer = null;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message, isError = false) {
  let element = $('toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    element.className = 'toast';
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.classList.toggle('err', Boolean(isError));
  element.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('on'), 2400);
}

async function apiJson(url, init = {}) {
  const response = await fetch(url, init);
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { response, json: json || { ok: false, error: `HTTP ${response.status}` } };
}

const adapter = new HttpDocumentAdapter({
  documentUrl: `/api/doc?path=${encodeURIComponent(DOC_PATH)}`,
  commentsUrl: `/api/comments?path=${encodeURIComponent(DOC_PATH)}`,
  commentsBatchUrl: `/api/comments/batch?path=${encodeURIComponent(DOC_PATH)}`,
});

editor.adapter = adapter;

function syncDocumentMeta(documentState) {
  const body = String(documentState?.body || '');
  $('doc-name').textContent = documentState?.title || DOC_PATH;
  $('doc-meta').textContent = `${body.split('\n').length} 行 · rev ${String(documentState?.rev || '').slice(0, 16)}`;
}

editor.addEventListener('comma-ready', (event) => syncDocumentMeta(event.detail.document));
editor.addEventListener('comma-save', (event) => syncDocumentMeta(event.detail.document));
editor.addEventListener('comma-conflict', () => toast('磁盘版本已变化，公共编辑器已重新载入最新内容。', true));
editor.addEventListener('comma-error', (event) => toast(event.detail?.error?.message || '编辑器操作失败', true));
editor.addEventListener('comma-ai-request', (event) => {
  if (event.detail?.mode === 'comment-batch') {
    startReview();
    return;
  }
  openAi(event.detail?.quoteText || '');
});

const REVIEW_STATUS = {
  running: '评审中', ready: '待写回', completed: '已同步',
  needs_attention: '部分需确认', needs_rebase: '原文已变化', failed: '运行失败',
};

function openReviewDrawer() {
  $('review-drawer').classList.add('open');
  $('review-drawer').setAttribute('aria-hidden', 'false');
  $('review-scrim').hidden = false;
}

function closeReviewDrawer() {
  $('review-drawer').classList.remove('open');
  $('review-drawer').setAttribute('aria-hidden', 'true');
  $('review-scrim').hidden = true;
}

function selectedReviewTool() {
  return document.querySelector('input[name="review-tool"]:checked')?.value || 'codex';
}

function setReviewRunning(running, message = '', isError = false) {
  reviewState.running = Boolean(running);
  for (const id of ['review-start', 'review-send', 'review-writeback']) $(id).disabled = Boolean(running);
  const stateElement = $('review-run-state');
  stateElement.hidden = !message;
  stateElement.textContent = message;
  stateElement.classList.toggle('error', Boolean(isError));
}

async function refreshEditorComments() {
  try { await editor.refreshComments(); } catch (error) { toast(error.message || '批注刷新失败', true); }
}

async function loadReviewSessions(loadLatest = false) {
  const { json } = await apiJson(`/api/review-sessions?path=${encodeURIComponent(DOC_PATH)}`);
  reviewState.sessions = json.ok && Array.isArray(json.sessions) ? json.sessions : [];
  renderReviewHistory();
  if (loadLatest && !reviewState.active && reviewState.sessions.length) {
    await loadReviewSession(reviewState.sessions[0].id);
  }
}

async function loadReviewSession(id) {
  const { json } = await apiJson(`/api/review-sessions/${encodeURIComponent(id)}`);
  if (!json.ok) return toast(json.error || '评审记录读取失败', true);
  reviewState.active = normalizeReviewSession(json.session);
  renderReviewSession();
}

function renderReviewHistory() {
  const root = $('review-history');
  root.textContent = '';
  if (!reviewState.sessions.length) {
    root.innerHTML = '<div class="history-empty">还没有评审记录。</div>';
    return;
  }
  reviewState.sessions.slice(0, 8).forEach((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row';
    row.innerHTML = `<strong>${esc((session.summary || '未命名评审').slice(0, 52))}</strong>
      <span>${esc(REVIEW_STATUS[session.status] || session.status || '')}</span>
      <span>${esc(`${String(session.tool || '').toUpperCase()} · ${session.updated_at || ''}`)}</span>
      <span>${Number(session.finding_count || 0)} 条</span>`;
    row.onclick = () => loadReviewSession(session.id);
    root.appendChild(row);
  });
}

function renderReviewSession() {
  const session = reviewState.active;
  $('review-empty').hidden = Boolean(session);
  $('review-session').hidden = !session;
  if (!session) return;
  const findings = session.findings || [];
  const accepted = findings.filter((finding) => finding.decision === 'accepted').length;
  const ready = findings.filter((finding) => finding.anchorState === 'ready').length;
  const applied = findings.filter((finding) => finding.appliedCommentId).length;
  const blocked = findings.filter((finding) => finding.anchorState !== 'ready').length;
  const status = $('review-status');
  status.className = `review-status ${session.status || ''}`;
  status.textContent = REVIEW_STATUS[session.status] || session.status || '未知';
  $('review-session-meta').textContent = `${session.tool.toUpperCase()} · ${session.id} · rev ${session.baseRev}`;
  $('review-summary').textContent = session.summary || '本轮未提供总评。';
  $('review-stats').innerHTML = [
    `<span class="review-stat">${findings.length} 条 findings</span>`,
    `<span class="review-stat">${accepted} 条已接受</span>`,
    `<span class="review-stat">${ready} 条锚点可靠</span>`,
    `<span class="review-stat">${applied} 条已写回</span>`,
    blocked ? `<span class="review-stat">${blocked} 条待定位</span>` : '',
  ].join('');
  renderFindings(findings);
  renderReviewMessages(session.messages || []);
}

function renderFindings(findings) {
  const root = $('review-findings');
  root.textContent = '';
  if (!findings.length) {
    root.innerHTML = '<div class="history-empty">这一轮没有生成可锚定的 findings。</div>';
    return;
  }
  findings.forEach((finding) => {
    const card = document.createElement('article');
    card.className = `finding-card priority-${esc(finding.priority || 'P2')}${finding.decision === 'rejected' ? ' rejected' : ''}`;
    const anchorText = finding.anchorState === 'ready' ? '锚点可靠' : finding.anchorState === 'ambiguous' ? '锚点重复' : '锚点缺失';
    card.innerHTML = `<div class="finding-head">
        <span class="finding-id">${esc(finding.id)}</span>
        <span class="finding-priority">${esc(finding.priority)}</span>
        <span class="finding-section">${esc(finding.section || '未标章节')}</span>
        <span class="anchor-chip ${esc(finding.anchorState)}">${anchorText}</span>
      </div>
      <button type="button" class="finding-quote">「${esc(finding.quoteText.slice(0, 220))}」</button>
      <p class="finding-issue"><span class="finding-label">问题</span>${esc(finding.issue)}</p>
      <p class="finding-action"><span class="finding-label">建议</span>${esc(finding.action)}</p>
      ${finding.evidenceRequirement ? `<p class="finding-action"><span class="finding-label">证据</span>${esc(finding.evidenceRequirement)}</p>` : ''}
      <div class="finding-actions">
        <button type="button" data-decision="accepted" class="${finding.decision === 'accepted' ? 'active' : ''}">接受</button>
        <button type="button" data-decision="proposed" class="${finding.decision === 'proposed' ? 'active' : ''}">待议</button>
        <button type="button" data-decision="rejected" class="${finding.decision === 'rejected' ? 'active' : ''}">驳回</button>
        ${finding.appliedCommentId ? '<span class="finding-applied">✓ 已写回批注</span>' : ''}
      </div>`;
    card.querySelector('.finding-quote').onclick = () => {
      editor.jumpToQuote(finding.quoteText, finding.sourceLocator || {});
      closeReviewDrawer();
    };
    card.querySelectorAll('[data-decision]').forEach((button) => {
      button.onclick = () => decideFinding(finding.id, button.dataset.decision);
    });
    root.appendChild(card);
  });
}

function renderReviewMessages(messages) {
  const root = $('review-messages');
  root.textContent = '';
  messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `review-message ${message.role === 'user' ? 'user' : 'assistant'}`;
    item.textContent = message.content || '';
    root.appendChild(item);
  });
  root.scrollTop = root.scrollHeight;
}

async function startReview() {
  if (reviewState.running) return;
  if (editor.dirty) return toast('请先保存正文，再启动评审。', true);
  openReviewDrawer();
  const tool = selectedReviewTool();
  setReviewRunning(true, `${tool.toUpperCase()} 正在读取当前版本、生成 findings 并校验原文锚点。完整评审可能需要几分钟…`);
  const { json } = await apiJson('/api/review-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: DOC_PATH,
      base_rev: editor.documentState.rev,
      tool,
      instruction: $('review-instruction').value.trim(),
      writeback_policy: $('review-auto-writeback').checked ? 'auto-ready' : 'preview',
    }),
  });
  if (!json.ok) return setReviewRunning(false, json.message || json.error || '完整评审失败', true);
  reviewState.active = normalizeReviewSession(json.session);
  setReviewRunning(false, json.writeback?.ok
    ? '评审完成：可靠 findings 已写入公共编辑器批注，重复同步不会产生重复项。'
    : '评审完成：请确认清单后同步批注。');
  renderReviewSession();
  await refreshEditorComments();
  await loadReviewSessions(false);
}

async function continueReview() {
  const session = reviewState.active;
  const message = $('review-message').value.trim();
  if (!session || !message || reviewState.running) return;
  setReviewRunning(true, '正在结合你的意见更新 findings，并重新核验当前原文…');
  const { json } = await apiJson(`/api/review-sessions/${encodeURIComponent(session.id)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  });
  if (!json.ok) return setReviewRunning(false, json.message || json.error || '更新评审失败', true);
  $('review-message').value = '';
  reviewState.active = normalizeReviewSession(json.session);
  setReviewRunning(false, json.writeback?.ok ? '评审清单和批注已增量同步。' : '评审清单已更新。');
  renderReviewSession();
  await refreshEditorComments();
  await loadReviewSessions(false);
}

async function syncReview() {
  const session = reviewState.active;
  if (!session || reviewState.running) return;
  setReviewRunning(true, '正在校验文档版本和锚点，并执行幂等批注写回…');
  const { json } = await apiJson(`/api/review-sessions/${encodeURIComponent(session.id)}/writeback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!json.ok) {
    if (json.session) reviewState.active = normalizeReviewSession(json.session);
    setReviewRunning(false, json.message || json.error || '批注同步失败', true);
    renderReviewSession();
    return;
  }
  reviewState.active = normalizeReviewSession(json.session);
  const writeback = json.writeback || {};
  setReviewRunning(false, `同步完成：新增 ${(writeback.created || []).length}，更新 ${(writeback.updated || []).length}，跳过 ${(writeback.skipped || []).length}。`);
  renderReviewSession();
  await refreshEditorComments();
  await loadReviewSessions(false);
}

async function decideFinding(findingId, decision) {
  const session = reviewState.active;
  if (!session || reviewState.running) return;
  const { json } = await apiJson(`/api/review-sessions/${encodeURIComponent(session.id)}/findings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finding_id: findingId, decision }),
  });
  if (!json.ok) return toast(json.error || '更新 finding 失败', true);
  reviewState.active = normalizeReviewSession(json.session);
  renderReviewSession();
}

function resetReviewComposer() {
  reviewState.active = null;
  $('review-instruction').value = '';
  setReviewRunning(false, '已准备新评审；设置重点后点击“开始完整评审”。');
  renderReviewSession();
}

function openAi(selection) {
  $('ai-selection').textContent = selection ? `选中：${selection.slice(0, 200)}` : '（无选中，直接提问）';
  $('ai-prompt').value = '';
  $('ai-output').textContent = '';
  $('ai-modal').hidden = false;
  $('ai-modal').dataset.selection = selection || '';
  $('ai-prompt').focus();
}

async function sendAi() {
  const prompt = $('ai-prompt').value.trim();
  if (!prompt) return toast('请输入指令', true);
  const tool = document.querySelector('input[name="ai-tool"]:checked')?.value || 'claude';
  $('ai-output').textContent = `${tool} 运行中…`;
  const { json } = await apiJson('/api/ai-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, tool, prompt, selection: $('ai-modal').dataset.selection || '' }),
  });
  $('ai-output').textContent = json.ok
    ? `${json.stub ? '[stub] ' : `[${json.tool || tool}${json.elapsed_ms != null ? ` ${json.elapsed_ms}ms` : ''}] `}${json.output || '(空)'}`
    : `错误：${json.error || '未知'}`;
}

$('btn-review-history').onclick = async () => { openReviewDrawer(); if (!reviewState.active) await loadReviewSessions(true); };
$('review-close').onclick = closeReviewDrawer;
$('review-scrim').onclick = closeReviewDrawer;
$('review-start').onclick = startReview;
$('review-new').onclick = resetReviewComposer;
$('review-writeback').onclick = syncReview;
$('review-send').onclick = continueReview;
$('review-message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); continueReview(); }
});
$('ai-close').onclick = () => { $('ai-modal').hidden = true; };
$('ai-send').onclick = sendAi;

window.__COMMA_REVIEW__ = {
  editor, adapter, reviewState, startReview, continueReview, syncReview,
  loadReviewSession, loadReviewSessions,
};
window.__SPIKE__ = window.__COMMA_REVIEW__;

loadReviewSessions(false);
