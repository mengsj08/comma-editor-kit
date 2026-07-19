import {
  HttpDocumentAdapter,
  normalizeConversationSession,
  normalizeReviewSession,
  registerCommaEditor,
} from '/comma-kit/comma-editor.js';

registerCommaEditor();

const DOC_PATH = new URLSearchParams(location.search).get('doc') || 'paper.md';
const $ = (id) => document.getElementById(id);
const editor = $('comma-editor');
const reviewState = { active: null, sessions: [], running: false };
const conversationState = {
  active: null, sessions: [], sourceQuote: null, running: false,
  composerMode: 'root', parentMessageId: '', writebackMessageId: '', quickSource: null,
};
let runtimeCapabilities = null;
let runtimeLoading = null;
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

function runtimeTool(tool) {
  return runtimeCapabilities?.tools?.find((item) => item.id === tool) || null;
}

function runtimeToolReady(tool, capability = '') {
  const item = runtimeTool(tool);
  return Boolean(item?.ready && (!capability || item.capabilities?.[capability] !== false));
}

function runtimeToolState(item) {
  if (item?.ready) return { className: 'ready', label: '已登录，可调用', tag: 'READY' };
  if (item?.auth_state === 'not_authenticated') return { className: 'needs-login', label: '需要登录', tag: 'SIGN IN' };
  if (item?.auth_state === 'check_failed') return { className: 'check-failed', label: '状态检测失败', tag: 'CHECK' };
  return { className: 'missing', label: '未找到命令', tag: 'MISSING' };
}

function renderRuntimePopover(loadError = false) {
  const root = $('cli-popover-list');
  if (loadError || !runtimeCapabilities) {
    root.innerHTML = '<p>本地 Gateway 未能返回 CLI 状态；请重新检测。</p>';
    return;
  }
  root.innerHTML = runtimeCapabilities.tools.map((item) => {
    const state = runtimeToolState(item);
    return `<div class="cli-tool-row ${state.className}"><i aria-hidden="true"></i><span><strong>${esc(item.label || item.id)}</strong><small>${esc(item.detail || state.label)}</small></span><b>${state.tag}</b></div>`;
  }).join('');
}

function syncRuntimeControls() {
  const reviewInputs = [...document.querySelectorAll('input[name="review-tool"]')];
  const readyReview = reviewInputs.find((input) => runtimeToolReady(input.value, 'structured_review'));
  const selectedReview = reviewInputs.find((input) => input.checked);
  if (readyReview && !runtimeToolReady(selectedReview?.value, 'structured_review') && !reviewState.running) readyReview.checked = true;
  reviewInputs.forEach((input) => {
    input.disabled = reviewState.running || !runtimeToolReady(input.value, 'structured_review');
    input.closest('label')?.classList.toggle('is-unavailable', !runtimeToolReady(input.value, 'structured_review'));
  });

  if (conversationState.active) syncConversationTool(conversationState.active.tool, true);
  else syncConversationTool(selectedConversationTool(), false);

  $('review-start').disabled = reviewState.running || !runtimeToolReady(selectedReviewTool(), 'structured_review');
  $('review-send').disabled = reviewState.running || Boolean(reviewState.active && !runtimeToolReady(reviewState.active.tool, 'structured_review'));
  $('review-writeback').disabled = reviewState.running;
  const conversationTool = conversationState.active?.tool || selectedConversationTool();
  const noteOnly = conversationState.composerMode === 'note';
  $('conversation-send').disabled = conversationState.running || (!noteOnly && !runtimeToolReady(conversationTool, 'conversation'));
  $('conversation-writeback-confirm').disabled = conversationState.running;
}

async function loadRuntimeCapabilities() {
  if (runtimeLoading) return runtimeLoading;
  const badge = $('cli-status');
  badge.className = 'cli-status checking';
  badge.querySelector('span').textContent = 'CLI · 检测中';
  runtimeLoading = (async () => {
    try {
      const { response, json } = await apiJson('/api/runtime/capabilities', { cache: 'no-store' });
      if (!response.ok || !json.ok || !Array.isArray(json.tools)) throw new Error(json.error || `HTTP ${response.status}`);
      runtimeCapabilities = json;
      const readyCount = json.tools.filter((item) => item.ready).length;
      badge.className = `cli-status ${readyCount === json.tools.length ? 'ready' : readyCount ? 'partial' : 'offline'}`;
      badge.querySelector('span').textContent = readyCount ? `CLI · ${readyCount} 可用` : 'CLI · 未就绪';
      badge.title = readyCount ? `${readyCount} 个本机 CLI 已登录` : 'Codex 与 Claude CLI 均未就绪';
      renderRuntimePopover(false);
      syncRuntimeControls();
      return json;
    } catch (error) {
      runtimeCapabilities = null;
      badge.className = 'cli-status offline';
      badge.querySelector('span').textContent = 'CLI · 未连接';
      badge.title = error.message || 'CLI 状态检测失败';
      renderRuntimePopover(true);
      syncRuntimeControls();
      return null;
    } finally {
      runtimeLoading = null;
    }
  })();
  return runtimeLoading;
}

function openRuntimePopover() {
  $('cli-popover').hidden = false;
  $('cli-status').setAttribute('aria-expanded', 'true');
}

function closeRuntimePopover() {
  $('cli-popover').hidden = true;
  $('cli-status').setAttribute('aria-expanded', 'false');
}

async function requireRuntimeTool(tool, capability) {
  if (!runtimeCapabilities) await loadRuntimeCapabilities();
  if (runtimeToolReady(tool, capability)) return true;
  const item = runtimeTool(tool);
  const state = runtimeToolState(item);
  openRuntimePopover();
  toast(`${item?.label || tool} ${state.label}；请在右上角 CLI 状态中处理后重新检测。`, true);
  return false;
}

const adapter = new HttpDocumentAdapter({
  documentUrl: `/api/doc?path=${encodeURIComponent(DOC_PATH)}`,
  commentsUrl: `/api/comments?path=${encodeURIComponent(DOC_PATH)}`,
  commentsBatchUrl: `/api/comments/batch?path=${encodeURIComponent(DOC_PATH)}`,
  assetUrl: `/api/asset?doc=${encodeURIComponent(DOC_PATH)}`,
});

editor.adapter = adapter;
editor.selectionActions = [
  { id: 'quick-explain', label: '快速解释', title: '临时解释，不保存到讨论记录' },
  { id: 'discuss', label: '深入讨论', title: '围绕这段原文开始可分支的审阅对话' },
];

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
  }
});
editor.addEventListener('comma-selection-action', (event) => {
  const sourceQuote = {
    quoteText: event.detail?.quoteText || '',
    sourceLocator: event.detail?.sourceLocator || null,
    section: event.detail?.section || '',
  };
  if (event.detail?.actionId === 'quick-explain') quickExplain(sourceQuote);
  if (event.detail?.actionId === 'discuss') openConversationForQuote(sourceQuote);
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
  const stateElement = $('review-run-state');
  stateElement.hidden = !message;
  stateElement.textContent = message;
  stateElement.classList.toggle('error', Boolean(isError));
  syncRuntimeControls();
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
  if (!await requireRuntimeTool(tool, 'structured_review')) return;
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
  if (!await requireRuntimeTool(session.tool, 'structured_review')) return;
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

function selectedConversationTool() {
  return document.querySelector('input[name="conversation-tool"]:checked')?.value || 'codex';
}

function sourceQuotePayload(sourceQuote) {
  return {
    quote_text: sourceQuote?.quoteText || '',
    section: sourceQuote?.section || '',
    source_locator: sourceQuote?.sourceLocator || null,
  };
}

function openConversationDock() {
  $('conversation-dock').hidden = false;
  $('conversation-dock').classList.remove('collapsed');
  $('conversation-collapse').textContent = '⌄';
}

function closeConversationDock() {
  $('conversation-dock').hidden = true;
}

function setConversationRunning(running, message = '') {
  conversationState.running = Boolean(running);
  if (message) $('conversation-status').textContent = message;
  syncRuntimeControls();
}

function syncConversationTool(tool, locked = false) {
  const selected = document.querySelector(`input[name="conversation-tool"][value="${tool}"]`);
  if (selected) selected.checked = true;
  const inputs = [...document.querySelectorAll('input[name="conversation-tool"]')];
  const ready = inputs.find((input) => runtimeToolReady(input.value, 'conversation'));
  if (!locked && ready && !runtimeToolReady(inputs.find((input) => input.checked)?.value, 'conversation')) ready.checked = true;
  inputs.forEach((input) => {
    const unavailable = !runtimeToolReady(input.value, 'conversation');
    input.disabled = locked || conversationState.running || unavailable;
    input.closest('label')?.classList.toggle('is-unavailable', unavailable);
  });
  document.querySelector('.conversation-tool-switch').classList.toggle('is-locked', locked);
}

function setConversationSource(sourceQuote) {
  conversationState.sourceQuote = sourceQuote?.quoteText ? sourceQuote : null;
  const source = $('conversation-source');
  source.hidden = !conversationState.sourceQuote;
  $('conversation-quote').textContent = conversationState.sourceQuote?.quoteText || '';
}

async function loadConversationSessions(loadLatest = false) {
  const { json } = await apiJson(`/api/conversations?path=${encodeURIComponent(DOC_PATH)}`);
  conversationState.sessions = json.ok && Array.isArray(json.sessions) ? json.sessions : [];
  $('conversation-count').textContent = String(conversationState.sessions.length);
  renderConversationHistory();
  if (loadLatest && !conversationState.active && conversationState.sessions.length) {
    await loadConversationSession(conversationState.sessions[0].id);
  }
}

async function loadConversationSession(id) {
  const { json } = await apiJson(`/api/conversations/${encodeURIComponent(id)}`);
  if (!json.ok) return toast(json.error || '讨论记录读取失败', true);
  conversationState.active = normalizeConversationSession(json.session);
  setConversationSource(conversationState.active.sourceQuote);
  syncConversationTool(conversationState.active.tool, true);
  conversationState.composerMode = 'followup';
  conversationState.parentMessageId = lastAssistantMessage()?.id || '';
  openConversationDock();
  renderConversation();
}

function renderConversationHistory() {
  const root = $('conversation-history');
  root.textContent = '';
  conversationState.sessions.slice(0, 8).forEach((session) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = session.id === conversationState.active?.id ? 'active' : '';
    button.textContent = `“${String(session.source_quote?.quote_text || '').slice(0, 34)}”`;
    button.title = session.last_response || '';
    button.onclick = () => loadConversationSession(session.id);
    root.appendChild(button);
  });
}

function lastAssistantMessage() {
  return (conversationState.active?.messages || []).filter((message) => message.role === 'assistant').at(-1) || null;
}

function openConversationForQuote(sourceQuote) {
  conversationState.active = null;
  conversationState.composerMode = 'root';
  conversationState.parentMessageId = '';
  syncConversationTool(selectedConversationTool(), false);
  setConversationSource(sourceQuote);
  $('quick-explain').hidden = true;
  openConversationDock();
  renderConversation();
  $('conversation-message').value = '';
  $('conversation-message').focus();
}

async function quickExplain(sourceQuote) {
  conversationState.quickSource = sourceQuote;
  $('quick-quote').textContent = sourceQuote.quoteText;
  $('quick-output').textContent = '正在生成临时解释…';
  $('quick-explain').hidden = false;
  const tool = selectedConversationTool();
  if (!await requireRuntimeTool(tool, 'quick_explain')) {
    $('quick-output').textContent = '当前 CLI 未就绪。请在右上角 CLI 状态中检查安装或登录状态，然后点击“重新检测”。';
    return;
  }
  const { json } = await apiJson('/api/ai-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: DOC_PATH, tool, selection: sourceQuote.quoteText,
      prompt: '请用简明中文解释这段内容：它在论证中做了什么、证据边界在哪里、阅读时最需要注意什么。不要改写原文。',
    }),
  });
  $('quick-output').textContent = json.ok
    ? (json.output || '（没有返回内容）')
    : `解释失败：${json.error || '未知错误'}`;
  if (!json.ok && json.code === 'cli_unavailable') await loadRuntimeCapabilities();
}

function configureConversationComposer(mode = 'followup', parentMessageId = '') {
  conversationState.composerMode = mode;
  conversationState.parentMessageId = parentMessageId;
  const labels = {
    root: '开始一段引用式讨论', followup: '继续当前讨论',
    fork: '将从这条 AI 回复建立新分支', note: '给这条 AI 回复留下评论',
  };
  $('conversation-context').textContent = labels[mode] || labels.followup;
  $('conversation-context-cancel').hidden = mode === 'root' || mode === 'followup';
  $('conversation-message').placeholder = mode === 'note'
    ? '记录你对这条回复的判断，不会调用 AI…'
    : mode === 'fork' ? '从这里换一个假设、角度或证据路径…' : '继续追问这段原文…';
  $('conversation-send').textContent = mode === 'root' ? '开始讨论' : mode === 'note' ? '添加评论' : mode === 'fork' ? '创建分支' : '发送';
  $('conversation-message').value = '';
  $('conversation-message').focus();
  syncRuntimeControls();
}

function assistantMessageElement(message, notes) {
  const item = document.createElement('article');
  item.className = 'conversation-message assistant';
  item.innerHTML = `<div class="conversation-message-meta"><span>${esc(message.author || conversationState.active?.tool || 'AI')}</span><time>${esc(message.at || '')}</time></div>
    <div class="conversation-message-body">${esc(message.content)}</div>
    <div class="conversation-message-actions">
      <button type="button" data-conversation-action="followup" data-message-id="${esc(message.id)}">继续追问</button>
      <button type="button" data-conversation-action="note" data-message-id="${esc(message.id)}">评论</button>
      <button type="button" data-conversation-action="fork" data-message-id="${esc(message.id)}">⑂ 从此分叉</button>
      <button type="button" data-conversation-action="writeback" data-message-id="${esc(message.id)}">写回批注</button>
      ${message.writebackCommentId ? '<span class="written">✓ 已写回</span>' : ''}
    </div>`;
  for (const note of notes) {
    const noteElement = document.createElement('div');
    noteElement.className = 'conversation-note';
    noteElement.textContent = note.content;
    item.appendChild(noteElement);
  }
  return item;
}

function renderConversationBranch(branchId, container, branchStarts, notesByMessage, depth = 0) {
  if (depth > 8) return;
  const messages = (conversationState.active?.messages || []).filter(
    (message) => message.role !== 'note' && (message.branchId || 'main') === branchId,
  );
  for (const message of messages) {
    let item;
    if (message.role === 'user') {
      item = document.createElement('div');
      item.className = 'conversation-message user';
      item.textContent = message.content;
    } else {
      item = assistantMessageElement(message, notesByMessage.get(message.id) || []);
    }
    container.appendChild(item);
    for (const childBranchId of branchStarts.get(message.id) || []) {
      const branch = document.createElement('section');
      branch.className = 'conversation-branch';
      renderConversationBranch(childBranchId, branch, branchStarts, notesByMessage, depth + 1);
      container.appendChild(branch);
    }
  }
}

function renderConversation() {
  const session = conversationState.active;
  const hasScope = Boolean(conversationState.sourceQuote?.quoteText);
  $('conversation-empty').hidden = hasScope;
  $('conversation-tree').hidden = !session;
  $('conversation-composer').hidden = !hasScope;
  $('conversation-writeback-editor').hidden = true;
  if (!session) {
    $('conversation-tree').textContent = '';
    syncConversationTool(selectedConversationTool(), false);
    configureConversationComposer('root');
    $('conversation-status').textContent = hasScope ? '引用已固定；输入问题后建立讨论记录' : '围绕原文展开，不直接改稿';
    renderConversationHistory();
    return;
  }
  syncConversationTool(session.tool, true);
  $('conversation-status').textContent = `${session.tool.toUpperCase()} · ${session.messages.length} 条消息 · rev ${session.baseRev}`;
  const notesByMessage = new Map();
  const branchStarts = new Map();
  for (const message of session.messages) {
    if (message.role === 'note' && message.noteForMessageId) {
      if (!notesByMessage.has(message.noteForMessageId)) notesByMessage.set(message.noteForMessageId, []);
      notesByMessage.get(message.noteForMessageId).push(message);
    }
    if (message.branchFromMessageId && message.branchId) {
      if (!branchStarts.has(message.branchFromMessageId)) branchStarts.set(message.branchFromMessageId, []);
      if (!branchStarts.get(message.branchFromMessageId).includes(message.branchId)) {
        branchStarts.get(message.branchFromMessageId).push(message.branchId);
      }
    }
  }
  const tree = $('conversation-tree');
  tree.textContent = '';
  renderConversationBranch('main', tree, branchStarts, notesByMessage);
  configureConversationComposer('followup', lastAssistantMessage()?.id || '');
  tree.scrollTop = tree.scrollHeight;
  renderConversationHistory();
}

async function sendConversationMessage() {
  const content = $('conversation-message').value.trim();
  if (!content || conversationState.running) return;
  const mode = conversationState.composerMode;
  const tool = conversationState.active?.tool || selectedConversationTool();
  if (mode !== 'note' && !await requireRuntimeTool(tool, 'conversation')) return;
  setConversationRunning(true, mode === 'note' ? '正在记录评论…' : mode === 'fork' ? '正在生成分支回复…' : 'AI 正在围绕引用回复…');
  let url = '/api/conversations';
  let body;
  if (mode === 'root') {
    body = {
      path: DOC_PATH, base_rev: editor.documentState.rev, tool: selectedConversationTool(),
      source_quote: sourceQuotePayload(conversationState.sourceQuote), message: content,
    };
  } else if (mode === 'note') {
    url = `/api/conversations/${encodeURIComponent(conversationState.active.id)}/notes`;
    body = { parent_message_id: conversationState.parentMessageId, content };
  } else {
    url = `/api/conversations/${encodeURIComponent(conversationState.active.id)}/messages`;
    body = { parent_message_id: conversationState.parentMessageId, message: content, mode };
  }
  const { json } = await apiJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!json.ok) {
    setConversationRunning(false, json.message || json.error || '讨论失败');
    return toast(json.message || json.error || '讨论失败', true);
  }
  conversationState.active = normalizeConversationSession(json.session);
  setConversationSource(conversationState.active.sourceQuote);
  $('conversation-message').value = '';
  setConversationRunning(false, json.branch_created ? '新分支已建立' : mode === 'note' ? '评论已记录' : '回复完成');
  renderConversation();
  await loadConversationSessions(false);
}

function openConversationWriteback(messageId) {
  const message = conversationState.active?.messages.find((item) => item.id === messageId && item.role === 'assistant');
  if (!message) return;
  conversationState.writebackMessageId = messageId;
  $('conversation-writeback-content').value = message.content;
  $('conversation-writeback-editor').hidden = false;
  $('conversation-composer').hidden = true;
  $('conversation-writeback-content').focus();
}

async function writebackConversationMessage() {
  const session = conversationState.active;
  const content = $('conversation-writeback-content').value.trim();
  if (!session || !content || conversationState.running) return;
  setConversationRunning(true, '正在核对原文版本并写回批注…');
  const { json } = await apiJson(`/api/conversations/${encodeURIComponent(session.id)}/writeback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: conversationState.writebackMessageId, content }),
  });
  if (!json.ok) {
    setConversationRunning(false, json.message || json.error || '写回失败');
    return toast(json.message || json.error || '写回失败', true);
  }
  conversationState.active = normalizeConversationSession(json.session);
  setConversationRunning(false, json.action === 'created' ? '已写回为原文批注' : json.action === 'updated' ? '批注已更新' : '这条回复已经写回');
  await refreshEditorComments();
  renderConversation();
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
$('btn-conversations').onclick = async () => { openConversationDock(); await loadConversationSessions(!conversationState.active); renderConversation(); };
$('conversation-close').onclick = closeConversationDock;
$('conversation-collapse').onclick = () => {
  const collapsed = $('conversation-dock').classList.toggle('collapsed');
  $('conversation-collapse').textContent = collapsed ? '⌃' : '⌄';
};
$('conversation-source').onclick = () => {
  if (conversationState.sourceQuote) editor.jumpToQuote(
    conversationState.sourceQuote.quoteText, conversationState.sourceQuote.sourceLocator || {},
  );
};
$('conversation-send').onclick = sendConversationMessage;
$('conversation-message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendConversationMessage(); }
});
$('conversation-context-cancel').onclick = () => configureConversationComposer('followup', lastAssistantMessage()?.id || '');
$('conversation-tree').onclick = (event) => {
  const button = event.target.closest('[data-conversation-action]');
  if (!button) return;
  const action = button.dataset.conversationAction;
  const messageId = button.dataset.messageId;
  if (action === 'writeback') return openConversationWriteback(messageId);
  configureConversationComposer(action, messageId);
};
$('conversation-writeback-cancel').onclick = () => {
  $('conversation-writeback-editor').hidden = true;
  $('conversation-composer').hidden = false;
};
$('conversation-writeback-confirm').onclick = writebackConversationMessage;
$('quick-close').onclick = () => { $('quick-explain').hidden = true; };
$('quick-deepen').onclick = () => {
  if (conversationState.quickSource) openConversationForQuote(conversationState.quickSource);
};
$('cli-status').onclick = () => {
  if ($('cli-popover').hidden) openRuntimePopover();
  else closeRuntimePopover();
};
$('cli-redetect').onclick = async () => {
  await loadRuntimeCapabilities();
  openRuntimePopover();
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('.cli-status-wrap')) closeRuntimePopover();
});
document.querySelectorAll('input[name="review-tool"], input[name="conversation-tool"]').forEach((input) => {
  input.addEventListener('change', syncRuntimeControls);
});

window.__COMMA_REVIEW__ = {
  editor, adapter, reviewState, startReview, continueReview, syncReview,
  loadReviewSession, loadReviewSessions, conversationState, loadConversationSession,
  loadConversationSessions, openConversationForQuote, sendConversationMessage,
  loadRuntimeCapabilities, runtimeToolReady,
};
window.__SPIKE__ = window.__COMMA_REVIEW__;

loadRuntimeCapabilities();
loadReviewSessions(false);
loadConversationSessions(false);
