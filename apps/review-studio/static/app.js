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
const reviewState = {
  active: null, activeRun: null, sessions: [], running: false, preflight: null,
  acceptedOperationIds: new Set(),
};
const archiveState = { versions: [], drafts: [], currentRev: '', exportCapabilities: null, loading: false };
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
  const runAwaitingWriteback = reviewState.activeRun?.status === 'preview';
  $('review-writeback').disabled = reviewState.running
    || (Boolean(reviewState.activeRun) && (!runAwaitingWriteback || reviewState.acceptedOperationIds.size === 0));
  $('review-accept-all').disabled = reviewState.running || !runAwaitingWriteback;
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

function configureEditorActions() {
  editor.toolbarActions = [
    { id: 'article-overview', label: '文章总览', slot: 'primary', appliesTo: 'document.load' },
    { id: 'ai-review', label: 'AI Review', slot: 'primary', appliesTo: { capability: 'document.load', requiresCleanDocument: true } },
    { id: 'overall-comment', label: '全文批注', slot: 'primary', appliesTo: 'comments.create' },
    { id: 'comments', label: '批注', slot: 'primary', appliesTo: 'comments.list', count: 'comments' },
    { id: 'source-edit', label: '源码编辑', slot: 'overflow', appliesTo: { capability: 'document.save', requiresWritable: true } },
    { id: 'show-withdrawn', label: editor.showWithdrawnComments ? '隐藏已撤回' : '显示已撤回', slot: 'overflow', appliesTo: 'comments.list' },
  ];
  editor.commentActions = [
    { id: 'reply', label: '回复', appliesTo: { capability: 'reply', target: 'comment', lifecycleStates: ['active'] } },
    { id: 'edit', label: '编辑', appliesTo: { capability: 'update', target: 'comment', lifecycleStates: ['active'] } },
    { id: 'withdraw', label: '撤回', appliesTo: { capability: 'delete', target: 'comment', lifecycleStates: ['active'] } },
    { id: 'restore', label: '恢复', appliesTo: { capability: 'restore', target: 'comment', lifecycleStates: ['withdrawn'] } },
    { id: 'history', label: '查看修改记录', appliesTo: { capability: 'history', target: 'comment' } },
    { id: 'locate', label: '定位原文', appliesTo: { capability: 'list', target: 'comment', kinds: ['anchored'] } },
    { id: 'reply-edit', label: '编辑回复', appliesTo: { capability: 'reply', target: 'reply', states: ['active'] } },
    { id: 'reply-withdraw', label: '撤回回复', appliesTo: { capability: 'reply', target: 'reply', states: ['active'] } },
  ];
}

configureEditorActions();

function syncDocumentMeta(documentState) {
  const body = String(documentState?.body || '');
  $('doc-name').textContent = documentState?.title || DOC_PATH;
  $('doc-meta').textContent = `${body.split('\n').length} 行 · rev ${String(documentState?.rev || '').slice(0, 16)}`;
}

function openOverview() {
  const documentState = editor.documentState;
  const body = String(documentState?.body || '');
  $('overview-doc-name').textContent = documentState?.title || DOC_PATH;
  $('overview-rev').textContent = String(documentState?.rev || '—');
  $('overview-stats').textContent = `${body ? body.split('\n').length : 0} 行 · ${body.length.toLocaleString('zh-CN')} 字符`;
  $('overview-drawer').classList.add('open');
  $('overview-drawer').setAttribute('aria-hidden', 'false');
  $('overview-scrim').hidden = false;
}

function closeOverview() {
  $('overview-drawer').classList.remove('open');
  $('overview-drawer').setAttribute('aria-hidden', 'true');
  $('overview-scrim').hidden = true;
}

editor.addEventListener('comma-ready', (event) => syncDocumentMeta(event.detail.document));
editor.addEventListener('comma-save', (event) => {
  syncDocumentMeta(event.detail.document);
  loadVersions();
});
editor.addEventListener('comma-conflict', async (event) => {
  const draft = event.detail?.error?.draft;
  toast(draft ? '磁盘版本已变化；刚才的修改已保留为冲突草稿。' : '磁盘版本已变化，已重新载入最新内容。', true);
  openArchive('versions');
  await loadVersions();
});
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

editor.addEventListener('comma-toolbar-action', (event) => {
  const action = event.detail?.actionId;
  if (action === 'article-overview') openOverview();
  if (action === 'ai-review') editor.requestAiReview();
  if (action === 'overall-comment') editor.openOverallCommentComposer();
  if (action === 'comments') editor.toggleComments();
  if (action === 'source-edit') editor.openSourceEditor();
  if (action === 'show-withdrawn') {
    editor.showWithdrawnComments = !editor.showWithdrawnComments;
    configureEditorActions();
  }
});

editor.addEventListener('comma-comment-action', async (event) => {
  const detail = event.detail || {};
  const comment = detail.comment;
  try {
    if (detail.phase === 'activate') {
      if (detail.actionId === 'edit') {
        editor.openCommentAction(detail.commentId, {
          actionId: 'edit', label: '编辑批注', submitLabel: '保存修改', initialValue: comment.content,
        });
      }
      if (detail.actionId === 'reply') {
        editor.openCommentAction(detail.commentId, {
          actionId: 'reply', label: '回复批注', submitLabel: '添加回复', initialValue: '',
          placeholder: '围绕这条批注继续讨论',
        });
      }
      if (detail.actionId === 'reply-edit') {
        editor.openCommentAction(detail.commentId, {
          actionId: 'reply-edit', replyId: detail.replyId, label: '编辑回复',
          submitLabel: '保存回复', initialValue: detail.reply?.content || '',
        });
      }
      if (detail.actionId === 'withdraw') {
        if (!window.confirm('撤回后默认列表与计数将隐藏这条批注，但记录会保留。继续吗？')) return;
        await adapter.deleteComment(detail.commentId, {
          baseCommentVersion: detail.baseCommentVersion, actor: 'June', reason: 'user-withdrawn',
        });
        await refreshEditorComments();
      }
      if (detail.actionId === 'restore') {
        await adapter.restoreComment(detail.commentId, {
          baseCommentVersion: detail.baseCommentVersion, actor: 'June',
        });
        await refreshEditorComments();
      }
      if (detail.actionId === 'reply-withdraw') {
        if (!window.confirm('撤回这条回复？审计记录会保留。')) return;
        await adapter.deleteCommentReply(detail.commentId, detail.replyId, {
          baseCommentVersion: detail.baseCommentVersion, actor: 'June',
        });
        await refreshEditorComments();
      }
      if (detail.actionId === 'history') {
        const events = await adapter.listCommentEvents(detail.commentId);
        editor.showCommentDetails(detail.commentId, { label: '修改记录', items: events });
      }
      if (detail.actionId === 'locate') editor.jumpToComment(detail.commentId);
      return;
    }
    if (detail.phase === 'submit' && detail.actionId === 'edit') {
      await adapter.updateComment(detail.commentId, {
        baseCommentVersion: detail.baseCommentVersion, actor: 'June', content: detail.content,
      });
      await refreshEditorComments();
    }
    if (detail.phase === 'submit' && detail.actionId === 'reply') {
      await adapter.createCommentReply(detail.commentId, {
        baseCommentVersion: detail.baseCommentVersion, actor: 'June', content: detail.content,
      });
      await refreshEditorComments();
    }
    if (detail.phase === 'submit' && detail.actionId === 'reply-edit') {
      await adapter.updateCommentReply(detail.commentId, detail.replyId, {
        baseCommentVersion: detail.baseCommentVersion, actor: 'June', content: detail.content,
      });
      await refreshEditorComments();
    }
  } catch (error) {
    if (error?.code === 'COMMENT_VERSION_CONFLICT') {
      await refreshEditorComments();
      toast('这条批注已在别处更新；已载入当前版本，请重新操作。', true);
    } else {
      toast(error.message || '批注操作失败', true);
    }
  }
});

const REVIEW_STATUS = {
  running: '评审中', ready: '操作预览', preview: '操作预览', completed: '已完成',
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

function activateReviewSession(rawSession, rawRun = null) {
  const previousRunId = reviewState.activeRun?.id || '';
  const nextRun = rawRun || rawSession?.run || null;
  reviewState.active = rawSession ? normalizeReviewSession(rawSession) : null;
  reviewState.activeRun = nextRun;
  if (!nextRun || nextRun.id !== previousRunId || nextRun.status === 'completed') {
    reviewState.acceptedOperationIds = new Set(nextRun?.accepted_operation_ids || []);
  }
}

function openReviewPreflight() {
  $('review-preflight-modal').hidden = false;
  $('review-preflight-modal').setAttribute('aria-hidden', 'false');
  $('review-preflight-scrim').hidden = false;
}

function closeReviewPreflight() {
  $('review-preflight-modal').hidden = true;
  $('review-preflight-modal').setAttribute('aria-hidden', 'true');
  $('review-preflight-scrim').hidden = true;
}

const PREFLIGHT_ROUTE = {
  initial: { code: 'FIRST PASS', title: '当前稿件尚无完成评审', scope: '首次完整阅读；可靠 finding 将以 provisional 写入批注' },
  'view-latest': { code: 'NO DELTA', title: '正文与批注均未变化', scope: '默认查看最近评审；不会调用本机 CLI' },
  incremental: { code: 'LOCAL DELTA', title: '变化限定在低风险局部范围', scope: '建议只复审变更块、局部上下文与受影响批注' },
  full: { code: 'GLOBAL RISK', title: '变化命中保护章节', scope: '摘要、方法、结果、结论、引用或图表变化默认全文复审' },
};

function renderReviewPreflight(preflight) {
  reviewState.preflight = preflight;
  const documentDelta = preflight.document || {};
  const commentDelta = preflight.comments || {};
  const anchors = preflight.anchors || {};
  const route = { ...(PREFLIGHT_ROUTE[preflight.recommended_mode] || PREFLIGHT_ROUTE.full) };
  const comparisonIncomplete = (documentDelta.change_state === 'changed' && !documentDelta.baseline_body_available)
    || commentDelta.comparison_state === 'unknown';
  if (preflight.recommended_mode === 'full' && comparisonIncomplete) {
    route.title = '历史基线不足以安全缩小范围';
    route.scope = '缺少可核对的正文或批注基线快照，保守推荐全文复审';
  }
  const counts = ['added', 'edited', 'withdrawn', 'restored', 'replied']
    .map((key) => [key, Array.isArray(commentDelta[key]) ? commentDelta[key].length : 0]);
  const commentCount = counts.reduce((sum, row) => sum + row[1], 0);
  const sectionNames = (documentDelta.affected_sections || []).filter(Boolean);
  const missing = (anchors.missing || []).length;
  const ambiguous = (anchors.ambiguous || []).length;
  $('review-preflight-route-code').textContent = route.code;
  $('review-preflight-route').textContent = route.title;
  $('review-preflight-scope').textContent = route.scope;
  $('review-preflight-document').textContent = documentDelta.change_state === 'no-baseline'
    ? '无基线' : documentDelta.change_state === 'unchanged' ? '未变化' : `${(documentDelta.changed_blocks || []).length} 个块`;
  $('review-preflight-sections').textContent = sectionNames.length
    ? `影响章节：${sectionNames.join('、')}`
    : documentDelta.change_state === 'changed' && !documentDelta.baseline_body_available
      ? '基线正文快照不可用，无法安全缩小范围。'
      : '未检测到正文块级变化。';
  $('review-preflight-comments').textContent = commentCount ? `${commentCount} 项变化` : '未变化';
  $('review-preflight-comment-detail').textContent = [
    `新增 ${counts[0][1]}`, `人工编辑 ${counts[1][1]}`, `撤回 ${counts[2][1]}`,
    `恢复 ${counts[3][1]}`, `回复 ${counts[4][1]}`,
  ].join(' · ');
  $('review-preflight-anchors').textContent = missing || ambiguous ? `${missing + ambiguous} 项需处理` : `${Number(anchors.ready || 0)} 项可靠`;
  $('review-preflight-anchor-detail').textContent = `ready ${Number(anchors.ready || 0)} · missing ${missing} · ambiguous ${ambiguous}`;
  $('review-preflight-baseline').textContent = preflight.baseline_session
    ? `${preflight.baseline_session.id} · ${preflight.baseline_session.completed_at || '完成时间未知'}`
    : '无已完成评审；将建立首个 session';
  const protectedNames = documentDelta.protected_sections || [];
  $('review-preflight-reason').textContent = protectedNames.length
    ? `保护类别命中：${protectedNames.join('、')}。增量复审仍可手动选择，但属于明确降级。`
    : comparisonIncomplete
      ? '历史 session 缺少完整的 revision 快照；未把未知状态误报为“无变化”，因此保守路由到全文复审。'
      : preflight.recommended_mode === 'incremental'
      ? '变化仅限非保护章节或批注层；changed_blocks 只用于路由，不声称已判断语义影响。'
      : preflight.recommended_mode === 'view-latest'
        ? 'document rev 与 comments_rev 均等于基线；默认动作不会产生模型调用。'
        : '首次评审读取当前完整 Markdown；写入项保持 provisional，不能显示为已接受。';

  const primary = $('review-preflight-primary');
  const view = $('review-preflight-view');
  const incremental = $('review-preflight-incremental');
  const force = $('review-preflight-force');
  primary.disabled = false;
  view.hidden = !preflight.baseline_session || preflight.recommended_mode === 'view-latest';
  incremental.hidden = preflight.recommended_mode !== 'full';
  force.hidden = !preflight.baseline_session || preflight.recommended_mode === 'full';
  if (preflight.recommended_mode === 'initial') {
    primary.dataset.mode = 'initial'; primary.textContent = '开始首次评审';
  } else if (preflight.recommended_mode === 'view-latest') {
    primary.dataset.mode = 'view-latest'; primary.textContent = '查看最近评审';
  } else if (preflight.recommended_mode === 'incremental') {
    primary.dataset.mode = 'incremental'; primary.textContent = '增量复审';
  } else {
    primary.dataset.mode = 'forced-full'; primary.textContent = '全文复审';
  }
}

async function viewLatestReview() {
  const id = reviewState.preflight?.baseline_session?.id;
  if (!id) return;
  closeReviewPreflight();
  openReviewDrawer();
  await loadReviewSession(id);
}

const VERSION_KIND = {
  baseline: '初始版本', auto: '自动保存', checkpoint: '命名版本',
  restore: '历史恢复', recovery: '草稿恢复', external: '外部变更',
};

function formatArchiveTime(value) {
  const text = String(value || '');
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.replace('T', ' ') : date.toLocaleString('zh-CN', { hour12: false });
}

function setArchiveTab(tab) {
  const selected = tab === 'exports' ? 'exports' : 'versions';
  $('archive-tab-versions').classList.toggle('active', selected === 'versions');
  $('archive-tab-exports').classList.toggle('active', selected === 'exports');
  $('archive-versions').hidden = selected !== 'versions';
  $('archive-exports').hidden = selected !== 'exports';
  if (selected === 'exports') loadExportCapabilities();
}

function openArchive(tab = 'versions') {
  closeRuntimePopover();
  setArchiveTab(tab);
  $('archive-drawer').classList.add('open');
  $('archive-drawer').setAttribute('aria-hidden', 'false');
  $('archive-scrim').hidden = false;
  if (tab === 'versions') loadVersions();
}

function closeArchive() {
  $('archive-drawer').classList.remove('open');
  $('archive-drawer').setAttribute('aria-hidden', 'true');
  $('archive-scrim').hidden = true;
}

function renderDrafts() {
  const root = $('draft-list');
  $('draft-section').hidden = archiveState.drafts.length === 0;
  root.innerHTML = archiveState.drafts.map((draft) => `
    <article class="draft-card" data-draft-id="${esc(draft.id)}">
      <header><strong>${esc(draft.id)}</strong><time>${esc(formatArchiveTime(draft.created_at))}</time></header>
      <p>编辑冲突时保留 · ${Number(draft.line_count || 0)} 行 · ${Number(draft.char_count || 0)} 字符</p>
      <div class="draft-actions">
        <button type="button" data-draft-action="diff">与当前版本比较</button>
        <button class="primary" type="button" data-draft-action="restore">恢复为新版本</button>
        <button type="button" data-draft-action="dismiss">忽略草稿</button>
      </div>
    </article>`).join('');
}

function renderVersions() {
  const root = $('version-list');
  $('archive-current-rev').textContent = archiveState.currentRev || '—';
  $('version-count').textContent = String(archiveState.versions.length);
  renderDrafts();
  if (!archiveState.versions.length) {
    root.innerHTML = '<p class="archive-loading">还没有版本记录。</p>';
    return;
  }
  root.innerHTML = archiveState.versions.map((version) => {
    const current = version.rev === archiveState.currentRev && version === archiveState.versions[0];
    const label = version.label || VERSION_KIND[version.kind] || version.kind || '版本';
    return `<article class="version-card ${esc(version.kind || '')} ${current ? 'current' : ''}" data-version-id="${esc(version.id)}">
      <header><h4>${esc(label)}</h4><time>${esc(formatArchiveTime(version.created_at))}</time></header>
      <div class="version-meta"><span class="version-kind">${esc(VERSION_KIND[version.kind] || version.kind || 'snapshot')}</span><span>rev ${esc(String(version.rev || '').slice(0, 10))}</span><span>${Number(version.line_count || 0)} lines</span><span>${esc(version.actor || '')}</span></div>
      <div class="version-actions">
        <button type="button" data-version-action="diff">与当前比较</button>
        ${current ? '<button type="button" disabled>当前版本</button>' : '<button class="restore" type="button" data-version-action="restore">恢复为新版本</button>'}
      </div>
    </article>`;
  }).join('');
}

async function loadVersions(showError = false) {
  if (archiveState.loading) return;
  archiveState.loading = true;
  try {
    const { response, json } = await apiJson(`/api/versions?path=${encodeURIComponent(DOC_PATH)}`, { cache: 'no-store' });
    if (!response.ok || !json.ok) throw new Error(json.error || '版本读取失败');
    archiveState.versions = Array.isArray(json.versions) ? json.versions : [];
    archiveState.drafts = Array.isArray(json.drafts) ? json.drafts : [];
    archiveState.currentRev = json.current_rev || editor.documentState.rev || '';
    renderVersions();
  } catch (error) {
    if (showError) toast(error.message || '版本读取失败', true);
    $('version-list').innerHTML = '<p class="archive-loading">版本服务暂不可用。</p>';
  } finally {
    archiveState.loading = false;
  }
}

async function createCheckpoint() {
  const label = $('checkpoint-label').value.trim();
  if (!label) return toast('请先填写命名版本的名称。', true);
  const { response, json } = await apiJson('/api/versions/checkpoints', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, label, base_rev: editor.documentState.rev, actor: 'June' }),
  });
  if (!response.ok || !json.ok) return toast(json.message || json.error || '命名版本保存失败', true);
  $('checkpoint-label').value = '';
  toast('命名版本已保存。');
  await loadVersions(true);
}

async function showVersionDiff(versionId) {
  const { response, json } = await apiJson(`/api/versions/diff?path=${encodeURIComponent(DOC_PATH)}&from=${encodeURIComponent(versionId)}&to=current`, { cache: 'no-store' });
  if (!response.ok || !json.ok) return toast(json.error || '版本比较失败', true);
  $('diff-title').textContent = `${json.changed_lines || 0} 行变化 · 与当前版本比较`;
  $('diff-output').textContent = json.diff || '两个版本内容相同。';
  $('version-diff').hidden = false;
  $('version-diff').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function showDraftDiff(draftId) {
  const { response, json } = await apiJson(`/api/drafts/${encodeURIComponent(draftId)}/diff?path=${encodeURIComponent(DOC_PATH)}`, { cache: 'no-store' });
  if (!response.ok || !json.ok) return toast(json.error || '草稿比较失败', true);
  $('diff-title').textContent = `${json.changed_lines || 0} 行变化 · 冲突草稿与当前版本`;
  $('diff-output').textContent = json.diff || '草稿与当前版本内容相同。';
  $('version-diff').hidden = false;
  $('version-diff').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function restoreVersion(versionId) {
  if (!window.confirm('恢复会把该快照写成一个新的当前版本，现有历史不会删除。继续吗？')) return;
  const { response, json } = await apiJson(`/api/versions/${encodeURIComponent(versionId)}/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, base_rev: editor.documentState.rev, actor: 'June' }),
  });
  if (!response.ok || !json.ok) return toast(json.message || json.error || '版本恢复失败', true);
  await editor.load();
  await loadVersions(true);
  toast('历史快照已恢复为新的当前版本。');
}

async function restoreDraft(draftId) {
  if (!window.confirm('将冲突草稿恢复为新的当前版本？当前版本仍会保留在历史中。')) return;
  const { response, json } = await apiJson(`/api/drafts/${encodeURIComponent(draftId)}/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, base_rev: editor.documentState.rev, actor: 'June' }),
  });
  if (!response.ok || !json.ok) return toast(json.message || json.error || '草稿恢复失败', true);
  await editor.load();
  await loadVersions(true);
  toast('冲突草稿已恢复为新的当前版本。');
}

async function dismissDraft(draftId) {
  const { response, json } = await apiJson(`/api/drafts/${encodeURIComponent(draftId)}/dismiss`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, actor: 'June' }),
  });
  if (!response.ok || !json.ok) return toast(json.error || '草稿处理失败', true);
  await loadVersions(true);
}

async function loadExportCapabilities() {
  const { response, json } = await apiJson('/api/exports/capabilities', { cache: 'no-store' });
  if (!response.ok || !json.ok) return toast(json.error || '导出能力检测失败', true);
  archiveState.exportCapabilities = json;
  ['docx', 'pdf'].forEach((format) => {
    const capability = json.formats?.[format];
    const button = document.querySelector(`[data-export-format="${format}"]`);
    const detail = document.querySelector(`[data-export-detail="${format}"]`);
    button.disabled = !capability?.ready;
    detail.textContent = capability?.ready ? `${capability.engine} 已就绪` : (capability?.detail || '本机转换器未就绪');
  });
}

function downloadExport(format) {
  const capability = archiveState.exportCapabilities?.formats?.[format];
  if (capability && capability.ready === false) return toast(capability.detail || '该导出格式未就绪', true);
  const anchor = document.createElement('a');
  anchor.href = `/api/export?path=${encodeURIComponent(DOC_PATH)}&format=${encodeURIComponent(format)}&version=current`;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
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
  activateReviewSession(json.session);
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
  const run = reviewState.activeRun;
  $('review-empty').hidden = Boolean(session);
  $('review-session').hidden = !session;
  if (!session) {
    updateOperationSelectionControls();
    return;
  }
  const findings = session.findings || [];
  const accepted = findings.filter((finding) => finding.decision === 'accepted').length;
  const ready = findings.filter((finding) => finding.anchorState === 'ready').length;
  const applied = findings.filter((finding) => finding.appliedCommentId).length;
  const blocked = findings.filter((finding) => finding.anchorState !== 'ready').length;
  const status = $('review-status');
  status.className = `review-status ${session.status || ''}`;
  status.textContent = REVIEW_STATUS[session.status] || session.status || '未知';
  $('review-session-meta').textContent = `${session.tool.toUpperCase()} · ${run?.mode || 'legacy'} · ${session.id} · rev ${session.baseRev}`;
  $('review-summary').textContent = session.summary || '本轮未提供总评。';
  const operationCounts = (run?.operations || []).reduce((counts, operation) => {
    counts[operation.action] = (counts[operation.action] || 0) + 1;
    return counts;
  }, {});
  $('review-stats').innerHTML = [
    `<span class="review-stat">${findings.length} 条 findings</span>`,
    `<span class="review-stat">${accepted} 条已接受</span>`,
    `<span class="review-stat">${ready} 条锚点可靠</span>`,
    `<span class="review-stat">${applied} 条已写回</span>`,
    blocked ? `<span class="review-stat">${blocked} 条待定位</span>` : '',
    run ? `<span class="review-stat">操作：新增 ${operationCounts.create || 0} · 修改 ${operationCounts.update || 0} · 撤回 ${operationCounts.withdraw || 0} · 不变 ${operationCounts.keep || 0} · 阻断 ${operationCounts.blocked || 0}</span>` : '',
  ].join('');
  $('review-ledger-eyebrow').textContent = run ? 'OPERATION PREVIEW' : 'FINDINGS LEDGER';
  $('review-ledger-title').textContent = run ? '操作预览' : '评审清单';
  if (run) renderOperationPreview(run);
  else renderFindings(findings);
  updateOperationSelectionControls();
  renderReviewMessages(session.messages || []);
}

const OPERATION_GROUPS = [
  { action: 'create', label: '新增', code: 'CREATE' },
  { action: 'update', label: '修改', code: 'UPDATE' },
  { action: 'withdraw', label: '撤回', code: 'WITHDRAW' },
  { action: 'keep', label: '不变', code: 'KEEP' },
  { action: 'blocked', label: '阻断', code: 'BLOCKED' },
];

function operationField(operation, camel, snake) {
  return operation?.[camel] ?? operation?.[snake] ?? '';
}

function updateOperationSelectionControls() {
  const run = reviewState.activeRun;
  const selection = $('review-operation-selection');
  const confirm = $('review-writeback');
  const acceptAll = $('review-accept-all');
  if (!run) {
    selection.hidden = true;
    acceptAll.hidden = true;
    confirm.hidden = false;
    confirm.textContent = '同步已接受批注';
    syncRuntimeControls();
    return;
  }
  const operations = run.operations || [];
  const humanPending = operations.filter((operation) => (
    operation.action === 'update'
    && Boolean(operationField(operation, 'humanEditedTarget', 'human_edited_target'))
    && !reviewState.acceptedOperationIds.has(operation.id)
  )).length;
  selection.hidden = false;
  if (run.status === 'completed') {
    selection.textContent = `写回已完成 · receipt ${run.writeback_receipt_id || '已记录'} · ${reviewState.acceptedOperationIds.size} 项操作`;
  } else {
    selection.textContent = `已选择 ${reviewState.acceptedOperationIds.size} 项。${humanPending ? `${humanPending} 条人工编辑目标未纳入批量接受，必须逐条显式勾选。` : '提交时再次校验 document rev、comments_rev 与 operation ids。'}`;
  }
  acceptAll.hidden = run.status !== 'preview';
  confirm.hidden = run.status !== 'preview';
  confirm.textContent = '确认写回已选操作';
  syncRuntimeControls();
}

function renderOperationPreview(run) {
  const root = $('review-findings');
  root.textContent = '';
  root.className = 'review-findings operation-preview';
  const operations = run.operations || [];
  OPERATION_GROUPS.forEach((group) => {
    const section = document.createElement('section');
    section.className = `operation-group operation-group-${group.action}`;
    section.dataset.operationGroup = group.action;
    const grouped = operations.filter((operation) => operation.action === group.action);
    section.innerHTML = `<header><span>${group.code}</span><h4>${group.label}</h4><b>${grouped.length}</b></header><div class="operation-group-list"></div>`;
    const list = section.querySelector('.operation-group-list');
    if (!grouped.length) {
      list.innerHTML = '<div class="history-empty">本组无操作。</div>';
    }
    grouped.forEach((operation) => {
      const proposed = operation.proposed_comment || operation.proposedComment || {};
      const humanEdited = group.action === 'update'
        && Boolean(operationField(operation, 'humanEditedTarget', 'human_edited_target'));
      const blocked = group.action === 'blocked';
      const checked = reviewState.acceptedOperationIds.has(operation.id);
      const card = document.createElement('article');
      card.className = `operation-card${humanEdited ? ' human-edited' : ''}`;
      card.dataset.operationId = operation.id;
      card.dataset.operationAction = group.action;
      if (humanEdited) card.dataset.humanEdited = 'true';
      const targetId = operationField(operation, 'targetCommentId', 'target_comment_id');
      const findingId = operationField(operation, 'findingId', 'finding_id');
      const quote = proposed.quote_text || proposed.quoteText || '';
      const issue = proposed.issue || '';
      const action = proposed.action || '';
      const reason = operation.reason || (blocked ? '未提供阻断原因' : '');
      card.innerHTML = `<div class="operation-card-head">
          <span class="operation-id">${esc(operation.id)}</span>
          <span class="operation-finding">${esc(findingId || '无 finding id')}</span>
          ${targetId ? `<span class="operation-target">target ${esc(targetId)}</span>` : ''}
        </div>
        <div class="operation-copy">
          ${quote ? `<p class="operation-quote">「${esc(quote.slice(0, 260))}」</p>` : ''}
          ${issue ? `<p><span class="finding-label">问题</span>${esc(issue)}</p>` : ''}
          ${action ? `<p><span class="finding-label">建议</span>${esc(action)}</p>` : ''}
          ${reason ? `<p class="operation-reason"><span class="finding-label">原因</span>${esc(reason)}</p>` : ''}
        </div>
        ${humanEdited ? '<p class="human-edit-warning">该目标批注含人工编辑。批量接受不会选中此项；只有本项复选框的显式确认才允许覆盖。</p>' : ''}
        <label class="operation-accept${blocked ? ' blocked' : ''}">
          <input type="checkbox" data-operation-accept="${esc(operation.id)}" ${checked ? 'checked' : ''} ${blocked || run.status !== 'preview' ? 'disabled' : ''}>
          <span>${blocked ? '保持阻断 · 不可接受' : humanEdited ? '显式接受这次覆盖' : '接受此项'}</span>
        </label>`;
      const checkbox = card.querySelector('[data-operation-accept]');
      if (!blocked && run.status === 'preview') {
        checkbox.onchange = () => {
          if (checkbox.checked) reviewState.acceptedOperationIds.add(operation.id);
          else reviewState.acceptedOperationIds.delete(operation.id);
          updateOperationSelectionControls();
        };
      }
      list.appendChild(card);
    });
    root.appendChild(section);
  });
}

function acceptAllNonBlockedOperations() {
  const operations = reviewState.activeRun?.operations || [];
  reviewState.acceptedOperationIds = new Set(operations.filter((operation) => (
    operation.action !== 'blocked'
    && !(operation.action === 'update'
      && Boolean(operationField(operation, 'humanEditedTarget', 'human_edited_target')))
  )).map((operation) => operation.id));
  renderOperationPreview(reviewState.activeRun);
  updateOperationSelectionControls();
}

function renderFindings(findings) {
  const root = $('review-findings');
  root.textContent = '';
  root.className = 'review-findings';
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
  openReviewPreflight();
  reviewState.preflight = null;
  $('review-preflight-primary').disabled = true;
  $('review-preflight-route-code').textContent = 'CHECKING';
  $('review-preflight-route').textContent = '正在核对 revision、批注与锚点';
  $('review-preflight-scope').textContent = '确定性预检不会调用模型';
  const { response, json } = await apiJson(`/api/review-preflight?path=${encodeURIComponent(DOC_PATH)}`, { cache: 'no-store' });
  if (!response.ok || !json.ok || !json.preflight) {
    $('review-preflight-route-code').textContent = 'FAILED';
    $('review-preflight-route').textContent = '预检失败';
    $('review-preflight-scope').textContent = json.error || `HTTP ${response.status}`;
    return;
  }
  if (json.preflight.document?.current_rev !== editor.documentState.rev) {
    await editor.load();
    toast('磁盘 revision 已变化；编辑器已载入当前版本。', true);
  }
  renderReviewPreflight(json.preflight);
}

async function runReview(mode) {
  const preflight = reviewState.preflight;
  if (!preflight || reviewState.running) return;
  const tool = selectedReviewTool();
  if (!await requireRuntimeTool(tool, 'structured_review')) return;
  closeReviewPreflight();
  openReviewDrawer();
  const modeLabel = mode === 'initial' ? '首次完整评审' : mode === 'incremental' ? '增量复审' : '强制全文复审';
  setReviewRunning(true, `${tool.toUpperCase()} 正在执行${modeLabel}；模型返回后会先校验锚点并生成操作。`);
  const { json } = await apiJson('/api/review-runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: DOC_PATH,
      base_rev: preflight.document.current_rev,
      baseline_session_id: preflight.baseline_session?.id || '',
      comments_rev: preflight.comments.comments_rev,
      mode,
      tool,
      instruction: $('review-instruction').value.trim(),
    }),
  });
  if (!json.ok) return setReviewRunning(false, json.message || json.error || `${modeLabel}失败`, true);
  activateReviewSession(json.session, json.run);
  if (json.run?.status === 'running') {
    setReviewRunning(false, '相同 revision 的评审已在运行；已复用该 run，不会重复调用模型。');
  } else if (mode === 'initial' && json.writeback?.ok) {
    setReviewRunning(false, '首评完成：唯一可靠的 findings 已作为 provisional 批注写入，尚未视为已接受。');
  } else if (json.run?.status === 'needs_rebase') {
    setReviewRunning(false, '模型运行期间正文或批注发生变化；操作已保留，但需要重新预检。', true);
  } else {
    setReviewRunning(false, '复审完成：操作停在 preview，批注未发生写入。');
  }
  renderReviewSession();
  if (mode === 'initial') await refreshEditorComments();
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
  activateReviewSession(json.session, reviewState.activeRun);
  setReviewRunning(false, '评审清单已更新并停在 preview；批注未发生写入。');
  renderReviewSession();
  await refreshEditorComments();
  await loadReviewSessions(false);
}

async function syncReview() {
  const session = reviewState.active;
  if (!session || reviewState.running) return;
  const run = reviewState.activeRun;
  if (run) {
    const acceptedOperationIds = (run.operations || [])
      .filter((operation) => reviewState.acceptedOperationIds.has(operation.id))
      .map((operation) => operation.id);
    if (!acceptedOperationIds.length) return toast('请先选择至少一项非阻断操作。', true);
    setReviewRunning(true, '正在同一 mutation lock 内校验 document rev、comments_rev 与 operation ids…');
    const { response, json } = await apiJson(`/api/review-runs/${encodeURIComponent(run.id)}/writeback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_rev: run.input?.document_rev,
        comments_rev: run.input?.comments_rev,
        accepted_operation_ids: acceptedOperationIds,
      }),
    });
    if (!response.ok || !json.ok) {
      setReviewRunning(false, json.message || json.error || '操作写回失败；未写入任何部分结果。', true);
      renderReviewSession();
      return;
    }
    activateReviewSession(json.session, json.run);
    const receipt = json.writeback || {};
    setReviewRunning(false, `写回完成：新增 ${(receipt.created || []).length}，修改 ${(receipt.updated || []).length}，撤回 ${(receipt.withdrawn || []).length}，不变 ${(receipt.kept || []).length}。`);
    renderReviewSession();
    await refreshEditorComments();
    await loadReviewSessions(false);
    return;
  }
  setReviewRunning(true, '正在校验文档版本和锚点，并执行幂等批注写回…');
  const { json } = await apiJson(`/api/review-sessions/${encodeURIComponent(session.id)}/writeback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!json.ok) {
    if (json.session) activateReviewSession(json.session);
    setReviewRunning(false, json.message || json.error || '批注同步失败', true);
    renderReviewSession();
    return;
  }
  activateReviewSession(json.session);
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
  activateReviewSession(json.session);
  renderReviewSession();
}

function resetReviewComposer() {
  reviewState.active = null;
  reviewState.activeRun = null;
  reviewState.acceptedOperationIds = new Set();
  $('review-instruction').value = '';
  setReviewRunning(false, '当前视图已清空；点击“重新预检”后再选择评审范围。');
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
$('overview-close').onclick = closeOverview;
$('overview-scrim').onclick = closeOverview;
$('btn-versions').onclick = () => openArchive('versions');
$('btn-export').onclick = () => openArchive('exports');
$('archive-close').onclick = closeArchive;
$('archive-scrim').onclick = closeArchive;
document.querySelectorAll('[data-archive-tab]').forEach((button) => {
  button.onclick = () => setArchiveTab(button.dataset.archiveTab);
});
$('checkpoint-create').onclick = createCheckpoint;
$('checkpoint-label').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); createCheckpoint(); }
});
$('version-list').onclick = (event) => {
  const button = event.target.closest('[data-version-action]');
  if (!button) return;
  const versionId = button.closest('[data-version-id]')?.dataset.versionId;
  if (button.dataset.versionAction === 'diff') showVersionDiff(versionId);
  if (button.dataset.versionAction === 'restore') restoreVersion(versionId);
};
$('draft-list').onclick = (event) => {
  const button = event.target.closest('[data-draft-action]');
  if (!button) return;
  const draftId = button.closest('[data-draft-id]')?.dataset.draftId;
  if (button.dataset.draftAction === 'diff') showDraftDiff(draftId);
  if (button.dataset.draftAction === 'restore') restoreDraft(draftId);
  if (button.dataset.draftAction === 'dismiss') dismissDraft(draftId);
};
$('diff-close').onclick = () => { $('version-diff').hidden = true; };
$('export-list').onclick = (event) => {
  const button = event.target.closest('[data-export-format]');
  if (button && !button.disabled) downloadExport(button.dataset.exportFormat);
};
$('review-close').onclick = closeReviewDrawer;
$('review-scrim').onclick = closeReviewDrawer;
$('review-start').onclick = startReview;
$('review-preflight-close').onclick = closeReviewPreflight;
$('review-preflight-cancel').onclick = closeReviewPreflight;
$('review-preflight-scrim').onclick = closeReviewPreflight;
$('review-preflight-view').onclick = viewLatestReview;
$('review-preflight-incremental').onclick = () => runReview('incremental');
$('review-preflight-force').onclick = () => runReview('forced-full');
$('review-preflight-primary').onclick = () => {
  const mode = $('review-preflight-primary').dataset.mode;
  if (mode === 'view-latest') return viewLatestReview();
  return runReview(mode);
};
$('review-new').onclick = resetReviewComposer;
$('review-accept-all').onclick = acceptAllNonBlockedOperations;
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
  editor, adapter, reviewState, startReview, runReview, continueReview, syncReview,
  openReviewDrawer, closeReviewDrawer, loadReviewSession, loadReviewSessions,
  conversationState, loadConversationSession,
  loadConversationSessions, openConversationForQuote, sendConversationMessage,
  loadRuntimeCapabilities, runtimeToolReady, archiveState, loadVersions,
  openArchive, closeArchive, createCheckpoint, restoreVersion, restoreDraft,
  openOverview, closeOverview, renderReviewPreflight, closeReviewPreflight,
};
window.__SPIKE__ = window.__COMMA_REVIEW__;

loadRuntimeCapabilities();
loadVersions();
loadReviewSessions(false);
loadConversationSessions(false);
