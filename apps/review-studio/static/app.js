// app.js — Comma Review Studio host assembler.
// Reuses kanban markdown.js VERBATIM behind a minimal ctx shim, plus the
// surgically-extracted anchor.js. Card concepts (acceptance / promote / handoff
// / board nav / AI queue) are gone; only edit<->preview, comments+anchors and an
// optional AI panel remain. KaTeX is added via a marked math extension.
import { setupMarkdown } from '/static/markdown.js';
import { setupAnchor } from '/static/anchor.js';

const DOC_PATH = new URLSearchParams(location.search).get('doc') || 'paper.md';

// ---- tiny ui shim -------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
let toastTimer = null;
function toast(msg, isErr) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

const $ = (id) => document.getElementById(id);

// ---- ctx ----------------------------------------------------------
const ctx = {
  hasApi: true,
  ui: { esc, toast },
  dataState: { tasks: [] },
  uiState: {
    detail: { currentTaskPath: DOC_PATH, currentTaskBody: '', currentTaskRev: '', savedBodyContent: '', isEditMode: false, editorDirty: false, isSavingBody: false },
    fileMention: { extCode: {}, extImage: {}, extDocument: {}, icons: {}, visible: false },
    ai: { quoteHistoryLoaded: false },
    pendingUploadTasks: new Set(),
  },
  el: {
    lightboxOverlay: $('lightbox-overlay'),
    lightboxImage: $('lightbox-image'),
    lightboxCaption: $('lightbox-caption'),
    fmResults: $('fm-results'),
    fmTabs: $('fm-tabs'),
    fileMentionDd: $('file-mention-dd'),
    newProject: $('new-project'),
    detailEditor: $('detail-editor'),
    detailMdContent: $('detail-md-content'),
    detailEditMode: $('detail-edit-mode'),
  },
  api: { openInEditor: (p) => toast('（doc 模式）打开本地文件已禁用: ' + p, true) },
  // markdown.js calls into these; provide no-op / real hooks
  renderDetail: {
    openTaskDetail: () => {},
    openCommentSidebar: () => openSidebar(),
    refreshCommentSidebarAvailability: () => {},
  },
};

// ---- KaTeX via marked math extension ------------------------------
function installMathExtension() {
  if (!window.marked || !window.katex) return false;
  const renderTeX = (tex, displayMode) => {
    try {
      return window.katex.renderToString(tex, { displayMode, throwOnError: false });
    } catch (e) {
      return '<code class="katex-error">' + esc(tex) + '</code>';
    }
  };
  const inlineMath = {
    name: 'inlineMath', level: 'inline',
    start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      // $...$ but not $$...$$
      const m = /^\$(?!\$)((?:\\.|[^\$\\])+?)\$/.exec(src);
      if (!m) return undefined;
      return { type: 'inlineMath', raw: m[0], text: m[1] };
    },
    renderer(token) { return renderTeX(token.text, false); },
  };
  const blockMath = {
    name: 'blockMath', level: 'block',
    start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(src);
      if (!m) return undefined;
      return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    },
    renderer(token) { return '<div class="math-block">' + renderTeX(token.text, true) + '</div>'; },
  };
  window.marked.use({ extensions: [blockMath, inlineMath] });
  return true;
}

// ---- doc load / render / save ------------------------------------
const state = ctx.uiState.detail;
let comments = [];
const reviewState = { active: null, sessions: [], running: false };

async function apiJson(url, init) {
  const res = await fetch(url, init);
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { res, json: json || { ok: false, error: 'HTTP ' + res.status } };
}

// ---- block segmentation (Typora-style in-place editing) ----------
// Lex the RAW body into top-level tokens; token.raw concatenation reconstructs
// the source exactly, so cumulative offsets give each block's byte range in the
// source string. Splicing edits against these ranges keeps every *unedited*
// block byte-identical (provenance requirement).
let blockMap = [];          // [{index,start,end,raw,type}]
let activeBlockEditor = null;

function segmentBlocks(src) {
  const out = [];
  if (!window.marked || typeof window.marked.lexer !== 'function') {
    out.push({ index: 0, start: 0, end: src.length, raw: src, type: 'whole' });
    return out;
  }
  const tokens = window.marked.lexer(src);
  let offset = 0, idx = 0;
  for (const tok of tokens) {
    const raw = tok.raw || '';
    const start = offset;
    offset += raw.length;
    if (tok.type === 'space') continue;   // blank-line gaps: not editable blocks
    out.push({ index: idx++, start, end: offset, raw, type: tok.type });
  }
  return out;
}

function renderOneWrap(wrap, block) {
  ctx.markdown.renderMarkdownEnhanced(wrap, block.raw, DOC_PATH, {});
}

function renderPreview() {
  const container = ctx.el.detailMdContent;
  blockMap = segmentBlocks(state.currentTaskBody);
  container.textContent = '';
  activeBlockEditor = null;
  for (const b of blockMap) {
    const wrap = document.createElement('div');
    wrap.className = 'doc-block';
    wrap.dataset.blockIndex = String(b.index);
    wrap.dataset.sourceStart = String(b.start);
    wrap.dataset.sourceEnd = String(b.end);
    wrap.title = '点击就地编辑（' + b.type + '）';
    renderOneWrap(wrap, b);
    container.appendChild(wrap);
  }
  applyCommentAnchors();
}

function trailerOf(raw) {
  const m = /\n*$/.exec(raw);
  return m ? m[0] : '';
}

function enterBlockEdit(wrap, opts) {
  if (state.isEditMode) return;                 // whole-source mode takes over
  if (activeBlockEditor) { commitBlockEdit(false); }
  const idx = Number(wrap.dataset.blockIndex);
  const block = blockMap.find((b) => b.index === idx);
  if (!block) return;
  const trailer = trailerOf(block.raw);
  const content = block.raw.slice(0, block.raw.length - trailer.length);
  const ta = document.createElement('textarea');
  ta.className = 'block-editor';
  ta.spellcheck = false;
  ta.value = content;
  wrap.textContent = '';
  wrap.classList.add('editing');
  wrap.appendChild(ta);
  const autosize = () => {
    ta.style.height = 'auto';
    // 布局未稳时 scrollHeight 会虚高;夹在 [2行, 80% 视口] 内,超长块内部滚动
    const cap = Math.max(120, Math.floor(window.innerHeight * 0.8));
    ta.style.height = Math.min(ta.scrollHeight + 2, cap) + 'px';
  };
  ta.addEventListener('input', autosize);
  activeBlockEditor = { wrap, block, trailer, ta };
  ta.focus();
  autosize();                          // 同步先设一次(cap 兜底虚高)
  requestAnimationFrame(autosize);     // 布局稳定后校准(后台标签不跑也无妨)
  setTimeout(autosize, 50);
  if (opts && opts.cursorEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('blur', () => { if (activeBlockEditor && activeBlockEditor.ta === ta) commitBlockEdit(false); });
  ta.addEventListener('keydown', (e) => onBlockEditorKey(e, ta));
}

function onBlockEditorKey(e, ta) {
  if (e.key === 'Escape') {
    e.preventDefault();
    commitBlockEdit(true);          // discard
    return;
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    commitBlockEdit(false, { addAfter: true });   // commit + start next paragraph
    return;
  }
  if (e.key === 'Backspace' && ta.value === '' && ta.selectionStart === 0) {
    e.preventDefault();
    deleteActiveBlock();
  }
}

// Commit the active block editor. discard=true reverts. opts.addAfter spawns a
// fresh empty paragraph editor right after (the "keep writing" flow).
async function commitBlockEdit(discard, opts) {
  const ed = activeBlockEditor;
  if (!ed) return;
  activeBlockEditor = null;
  const newContent = ed.ta.value;
  const newRaw = newContent + ed.trailer;
  if (discard || newRaw === ed.block.raw) {
    ed.wrap.classList.remove('editing');
    renderOneWrap(ed.wrap, ed.block);
    applyCommentAnchors();
    return;
  }
  const src = state.currentTaskBody;
  const newSrc = src.slice(0, ed.block.start) + newRaw + src.slice(ed.block.end);
  const ok = await putDoc(newSrc, 'june');
  if (ok && opts && opts.addAfter) {
    // insert an empty paragraph slot right after the just-edited block, edit it
    insertParagraphAfter(ed.block.index);
  }
}

async function deleteActiveBlock() {
  const ed = activeBlockEditor;
  if (!ed) return;
  activeBlockEditor = null;
  const src = state.currentTaskBody;
  // drop this block's whole raw range (content + trailer)
  const newSrc = src.slice(0, ed.block.start) + src.slice(ed.block.end);
  await putDoc(newSrc, 'june');
}

// Insert a new empty paragraph after block `afterIdx` and open it for editing.
function insertParagraphAfter(afterIdx) {
  const block = blockMap.find((b) => b.index === afterIdx);
  const src = state.currentTaskBody;
  const at = block ? block.end : src.length;
  const needsLead = at > 0 && !src.slice(0, at).endsWith('\n\n');
  const inserted = (needsLead ? '\n\n' : '') + '​\n\n';   // ZWSP placeholder
  const newSrc = src.slice(0, at) + inserted + src.slice(at);
  state.currentTaskBody = newSrc;              // optimistic local; saved on commit
  renderPreview();
  const target = blockMap.find((b) => b.raw.includes('​'));
  if (target) {
    const wrap = ctx.el.detailMdContent.querySelector('[data-block-index="' + target.index + '"]');
    if (wrap) { enterBlockEdit(wrap, { cursorEnd: true }); if (activeBlockEditor) activeBlockEditor.ta.value = ''; }
  }
}

async function loadDoc() {
  const { json } = await apiJson('/api/doc?path=' + encodeURIComponent(DOC_PATH));
  if (!json.ok) { toast(json.error || '读取失败', true); return; }
  state.currentTaskBody = json.body;
  state.savedBodyContent = json.body;
  state.currentTaskRev = json.rev;
  $('doc-name').textContent = json.path;
  const lines = (json.body.match(/\n/g) || []).length + 1;
  $('doc-meta').textContent = lines + ' 行 · rev ' + json.rev;
  renderPreview();
  await loadComments();
}

function enterEdit() {
  state.isEditMode = true;
  ctx.el.detailEditor.value = state.savedBodyContent;
  ctx.el.detailMdContent.hidden = true;
  ctx.el.detailEditMode.hidden = false;
  $('btn-edit').hidden = true;
  $('editor-save').hidden = false;
  $('editor-cancel').hidden = false;
  ctx.el.detailEditor.focus();
}

function exitEdit() {
  if (state.editorDirty && !confirm('有未保存的更改，确定放弃吗？')) return;
  state.isEditMode = false;
  state.editorDirty = false;
  ctx.el.detailMdContent.hidden = false;
  ctx.el.detailEditMode.hidden = true;
  $('btn-edit').hidden = false;
  $('editor-save').hidden = true;
  $('editor-cancel').hidden = true;
  setStatus('', '');
}

function setStatus(cls, text) {
  const el = $('editor-status');
  el.className = 'editor-status ' + (cls || '');
  el.textContent = text || '';
}

// Shared writer: PUT the whole source with optimistic base_rev, update local
// state and re-render on success. Used by both whole-source mode and block edits.
// Returns true on success.
async function putDoc(newBody, actor) {
  if (state.isSavingBody) return false;
  state.isSavingBody = true;
  setStatus('saving', '保存中...');
  const { res, json } = await apiJson('/api/doc', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, body: newBody, base_rev: state.currentTaskRev, actor: actor || 'june' }),
  });
  state.isSavingBody = false;
  if (json.ok) {
    state.currentTaskBody = json.body;
    state.savedBodyContent = json.body;
    state.currentTaskRev = json.rev;
    state.editorDirty = false;
    setStatus('saved', '已保存');
    const lines = (json.body.match(/\n/g) || []).length + 1;
    $('doc-meta').textContent = lines + ' 行 · rev ' + json.rev;
    renderPreview();
    await loadComments();
    return true;
  }
  if (res.status === 409 || json.conflict) {
    setStatus('dirty', '冲突：磁盘已变化');
    toast(json.message || '保存冲突', true);
    // resync to the server copy so we don't clobber
    if (json.body != null) {
      state.currentTaskBody = json.body;
      state.savedBodyContent = json.body;
      state.currentTaskRev = json.rev;
      renderPreview();
    }
  } else {
    setStatus('dirty', '保存失败');
    toast(json.error || '保存失败', true);
  }
  return false;
}

async function saveDoc() {
  const newBody = ctx.el.detailEditor.value;
  if (newBody === state.savedBodyContent) { toast('没有修改需要保存'); return; }
  const ok = await putDoc(newBody, 'june');
  if (ok) { exitEdit(); toast('内容已保存'); }
}

// ---- comments + anchors ------------------------------------------
async function loadComments() {
  const { json } = await apiJson('/api/comments?path=' + encodeURIComponent(DOC_PATH));
  comments = (json.ok && json.comments) || [];
  $('header-comment-count').textContent = String(comments.length);
  renderCommentSidebar();
  applyCommentAnchors();
}

function applyCommentAnchors() {
  const root = ctx.el.detailMdContent;
  root.querySelectorAll('.comment-anchor-mark').forEach((n) => n.remove());
  root.querySelectorAll('.has-comment-anchor').forEach((n) => n.classList.remove('has-comment-anchor', 'anchor-stale'));
  comments.forEach((c, i) => {
    if (c.review_state === 'withdrawn') { c._resolved = true; return; }
    const target = ctx.anchor.resolveBodyQuoteTarget(c);
    c._resolved = !!target;
    if (!target) return;
    target.classList.add('has-comment-anchor');
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'comment-anchor-mark';
    mark.textContent = String(i + 1);
    mark.title = (c.author || '') + ': ' + (c.content || '');
    mark.onclick = () => focusComment(c.id);
    target.appendChild(mark);
  });
  // refresh sidebar staleness flags
  renderCommentSidebar();
}

function renderCommentSidebar() {
  const list = $('comment-list');
  $('comment-count').textContent = String(comments.length);
  list.textContent = '';
  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'comment-empty';
    empty.textContent = '还没有批注。';
    list.appendChild(empty);
    return;
  }
  comments.forEach((c, i) => {
    const card = document.createElement('article');
    card.className = 'comment-card' + (c._resolved === false ? ' is-stale' : '')
      + (c.review_state === 'withdrawn' ? ' is-withdrawn' : '')
      + (c.review_state === 'pending' ? ' is-pending' : '');
    card.dataset.commentId = c.id;
    const head = document.createElement('div');
    head.className = 'comment-card-head';
    head.innerHTML = '<span class="comment-num">' + (i + 1) + '</span><strong>' + esc(c.author || '匿名') + '</strong>'
      + (c.priority ? '<span class="finding-priority">' + esc(c.priority) + '</span>' : '')
      + '<span class="comment-anchor-state">'
      + (c.review_state === 'withdrawn' ? '已撤回' : (c.review_state === 'pending' ? '待议' : (c._resolved === false ? '锚点失效' : '锚点有效')))
      + '</span>';
    const ctxLine = document.createElement('button');
    ctxLine.type = 'button';
    ctxLine.className = 'comment-context';
    ctxLine.textContent = (c.section ? (c.section + ' · ') : '') + '「' + (c.quote_text || '').slice(0, 60) + '」';
    ctxLine.onclick = () => ctx.anchor.jumpToBodyQuote(c);
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = c.content || '（空批注）';
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑';
    edit.onclick = () => editComment(c);
    const del = document.createElement('button'); del.type = 'button'; del.textContent = '删除';
    del.onclick = () => deleteComment(c.id);
    actions.appendChild(edit); actions.appendChild(del);
    card.appendChild(head); card.appendChild(ctxLine); card.appendChild(body); card.appendChild(actions);
    list.appendChild(card);
  });
}

function focusComment(id) {
  openSidebar();
  const card = $('comment-list').querySelector('[data-comment-id="' + CSS.escape(id) + '"]');
  if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('is-located'); setTimeout(() => card.classList.remove('is-located'), 1600); }
}

async function createComment(sourceQuote, content) {
  const { json } = await apiJson('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: DOC_PATH, author: 'June', content,
      quote_text: sourceQuote.quote_text, section: sourceQuote.section,
      source_locator: sourceQuote.source_locator,
    }),
  });
  if (!json.ok) { toast(json.error || '创建批注失败', true); return; }
  comments = json.comments;
  applyCommentAnchors();
  openSidebar();
  toast('批注已添加');
}

async function editComment(c) {
  const content = prompt('编辑批注：', c.content || '');
  if (content == null) return;
  const { json } = await apiJson('/api/comments', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, id: c.id, content }),
  });
  if (json.ok) { comments = json.comments; applyCommentAnchors(); toast('已保存'); }
}

async function deleteComment(id) {
  const { json } = await apiJson('/api/comments', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, id }),
  });
  if (json.ok) { comments = json.comments; applyCommentAnchors(); toast('已删除'); }
}

function openSidebar() { $('comment-sidebar').classList.add('open'); }

// ---- selection popover (add comment / ask AI) --------------------
let pendingQuote = null;
function onSelection() {
  const sel = window.getSelection();
  const pop = $('sel-popover');
  if (state.isEditMode || !sel || sel.isCollapsed || !sel.rangeCount) { pop.hidden = true; return; }
  const range = sel.getRangeAt(0);
  if (!ctx.el.detailMdContent.contains(range.commonAncestorContainer)) { pop.hidden = true; return; }
  const text = String(sel.toString() || '').trim();
  if (!text) { pop.hidden = true; return; }
  pendingQuote = ctx.anchor.sourceQuoteFromSelection(text.slice(0, 2000), range);
  const rect = range.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 190)) + 'px';
  pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  pop.hidden = false;
}

// ---- AI panel -----------------------------------------------------
function openAi(selection) {
  $('ai-selection').textContent = selection ? ('选中：' + selection.slice(0, 200)) : '（无选中，直接提问）';
  $('ai-prompt').value = '';
  $('ai-output').textContent = '';
  $('ai-modal').hidden = false;
  $('ai-modal').dataset.selection = selection || '';
  $('ai-prompt').focus();
}

function selectedAiTool() {
  const el = document.querySelector('input[name="ai-tool"]:checked');
  return el ? el.value : 'claude';
}

async function sendAi() {
  const prompt = $('ai-prompt').value.trim();
  if (!prompt) { toast('请输入指令', true); return; }
  const tool = selectedAiTool();
  $('ai-output').textContent = tool + ' 运行中…';
  const { json } = await apiJson('/api/ai-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DOC_PATH, tool, prompt, selection: $('ai-modal').dataset.selection || '' }),
  });
  if (json.ok) {
    const meta = json.stub ? '[stub] '
      : `[${json.tool || tool}` + (json.elapsed_ms != null ? ` ${json.elapsed_ms}ms` : '')
        + (json.returncode != null ? ` rc=${json.returncode}` : '') + '] ';
    $('ai-output').textContent = meta + (json.output || '(空)');
  } else {
    $('ai-output').textContent = '错误：' + (json.error || '未知');
  }
}

// ---- structured AI review ----------------------------------------
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
  const el = document.querySelector('input[name="review-tool"]:checked');
  return el ? el.value : 'codex';
}

function setReviewRunning(running, message, isError) {
  reviewState.running = !!running;
  $('review-start').disabled = !!running;
  $('btn-ai-review').disabled = !!running;
  $('review-send').disabled = !!running;
  $('review-writeback').disabled = !!running;
  const stateEl = $('review-run-state');
  if (!message) {
    stateEl.hidden = true;
    stateEl.textContent = '';
    stateEl.classList.remove('error');
  } else {
    stateEl.hidden = false;
    stateEl.textContent = message;
    stateEl.classList.toggle('error', !!isError);
  }
}

async function loadReviewSessions(loadLatest) {
  const { json } = await apiJson('/api/review-sessions?path=' + encodeURIComponent(DOC_PATH));
  reviewState.sessions = (json.ok && json.sessions) || [];
  renderReviewHistory();
  if (loadLatest && !reviewState.active && reviewState.sessions.length) {
    await loadReviewSession(reviewState.sessions[0].id);
  }
}

async function loadReviewSession(id) {
  const { json } = await apiJson('/api/review-sessions/' + encodeURIComponent(id));
  if (!json.ok) { toast(json.error || '评审记录读取失败', true); return; }
  reviewState.active = json.session;
  renderReviewSession();
}

function renderReviewHistory() {
  const root = $('review-history');
  root.textContent = '';
  if (!reviewState.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '还没有评审记录。';
    root.appendChild(empty);
    return;
  }
  reviewState.sessions.slice(0, 8).forEach((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row';
    row.innerHTML = '<strong>' + esc((session.summary || '未命名评审').slice(0, 52)) + '</strong>'
      + '<span>' + esc(REVIEW_STATUS[session.status] || session.status || '') + '</span>'
      + '<span>' + esc((session.tool || '').toUpperCase() + ' · ' + (session.updated_at || '')) + '</span>'
      + '<span>' + Number(session.finding_count || 0) + ' 条</span>';
    row.onclick = () => loadReviewSession(session.id);
    root.appendChild(row);
  });
}

function renderReviewSession() {
  const session = reviewState.active;
  $('review-empty').hidden = !!session;
  $('review-session').hidden = !session;
  if (!session) return;
  const findings = session.findings || [];
  const accepted = findings.filter((f) => f.decision === 'accepted').length;
  const ready = findings.filter((f) => f.anchor_state === 'ready').length;
  const applied = findings.filter((f) => f.applied_comment_id).length;
  const blocked = findings.filter((f) => f.anchor_state !== 'ready').length;
  const status = $('review-status');
  status.className = 'review-status ' + (session.status || '');
  status.textContent = REVIEW_STATUS[session.status] || session.status || '未知';
  $('review-session-meta').textContent = (session.tool || '').toUpperCase() + ' · ' + (session.id || '') + ' · rev ' + (session.base_rev || '');
  $('review-summary').textContent = session.summary || '本轮未提供总评。';
  $('review-stats').innerHTML = [
    '<span class="review-stat">' + findings.length + ' 条 findings</span>',
    '<span class="review-stat">' + accepted + ' 条已接受</span>',
    '<span class="review-stat">' + ready + ' 条锚点可靠</span>',
    '<span class="review-stat">' + applied + ' 条已写回</span>',
    blocked ? '<span class="review-stat">' + blocked + ' 条待定位</span>' : '',
  ].join('');
  renderFindings(findings);
  renderReviewMessages(session.messages || []);
}

function renderFindings(findings) {
  const root = $('review-findings');
  root.textContent = '';
  if (!findings.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '这一轮没有生成可锚定的 findings。';
    root.appendChild(empty);
    return;
  }
  findings.forEach((f) => {
    const card = document.createElement('article');
    card.className = 'finding-card priority-' + esc(f.priority || 'P2') + (f.decision === 'rejected' ? ' rejected' : '');
    const anchorText = f.anchor_state === 'ready' ? '锚点可靠' : (f.anchor_state === 'ambiguous' ? '锚点重复' : '锚点缺失');
    card.innerHTML = '<div class="finding-head">'
      + '<span class="finding-id">' + esc(f.id || '') + '</span>'
      + '<span class="finding-priority">' + esc(f.priority || 'P2') + '</span>'
      + '<span class="finding-section">' + esc(f.section || '未标章节') + '</span>'
      + '<span class="anchor-chip ' + esc(f.anchor_state || '') + '">' + anchorText + '</span>'
      + '</div>'
      + '<button type="button" class="finding-quote">「' + esc((f.quote_text || '').slice(0, 220)) + '」</button>'
      + '<p class="finding-issue"><span class="finding-label">问题</span>' + esc(f.issue || '') + '</p>'
      + '<p class="finding-action"><span class="finding-label">建议</span>' + esc(f.action || '') + '</p>'
      + (f.evidence_requirement ? '<p class="finding-action"><span class="finding-label">证据</span>' + esc(f.evidence_requirement) + '</p>' : '')
      + '<div class="finding-actions">'
      + '<button type="button" data-decision="accepted" class="' + (f.decision === 'accepted' ? 'active' : '') + '">接受</button>'
      + '<button type="button" data-decision="proposed" class="' + (f.decision === 'proposed' ? 'active' : '') + '">待议</button>'
      + '<button type="button" data-decision="rejected" class="' + (f.decision === 'rejected' ? 'active' : '') + '">驳回</button>'
      + (f.applied_comment_id ? '<span class="finding-applied">✓ 已写回批注</span>' : '')
      + '</div>';
    card.querySelector('.finding-quote').onclick = () => {
      ctx.anchor.jumpToBodyQuote({ quote_text: f.quote_text, source_locator: f.source_locator || {} });
      closeReviewDrawer();
    };
    card.querySelectorAll('[data-decision]').forEach((button) => {
      button.onclick = () => decideFinding(f.id, button.dataset.decision);
    });
    root.appendChild(card);
  });
}

function renderReviewMessages(messages) {
  const root = $('review-messages');
  root.textContent = '';
  messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = 'review-message ' + (message.role === 'user' ? 'user' : 'assistant');
    item.textContent = message.content || '';
    root.appendChild(item);
  });
  root.scrollTop = root.scrollHeight;
}

async function startReview() {
  if (reviewState.running) return;
  openReviewDrawer();
  const tool = selectedReviewTool();
  setReviewRunning(true, tool.toUpperCase() + ' 正在读取当前版本、生成 findings 并校验原文锚点。完整评审可能需要几分钟…');
  const { json } = await apiJson('/api/review-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: DOC_PATH,
      base_rev: state.currentTaskRev,
      tool,
      instruction: $('review-instruction').value.trim(),
      writeback_policy: $('review-auto-writeback').checked ? 'auto-ready' : 'preview',
    }),
  });
  if (!json.ok) {
    setReviewRunning(false, json.message || json.error || '完整评审失败', true);
    return;
  }
  reviewState.active = json.session;
  setReviewRunning(false, json.writeback && json.writeback.ok
    ? '评审完成：可靠 findings 已写入批注，重复点击同步不会产生重复批注。'
    : '评审完成：请确认清单后同步批注。');
  renderReviewSession();
  await loadComments();
  await loadReviewSessions(false);
}

async function continueReview() {
  const session = reviewState.active;
  const message = $('review-message').value.trim();
  if (!session || !message || reviewState.running) return;
  setReviewRunning(true, '正在结合你的意见更新 findings，并重新核验当前原文…');
  const { json } = await apiJson('/api/review-sessions/' + encodeURIComponent(session.id) + '/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!json.ok) {
    setReviewRunning(false, json.message || json.error || '更新评审失败', true);
    return;
  }
  $('review-message').value = '';
  reviewState.active = json.session;
  setReviewRunning(false, json.writeback && json.writeback.ok ? '评审清单和批注已增量同步。' : '评审清单已更新。');
  renderReviewSession();
  await loadComments();
  await loadReviewSessions(false);
}

async function syncReview() {
  const session = reviewState.active;
  if (!session || reviewState.running) return;
  setReviewRunning(true, '正在校验文档版本和锚点，并执行幂等批注写回…');
  const { json } = await apiJson('/api/review-sessions/' + encodeURIComponent(session.id) + '/writeback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!json.ok) {
    if (json.session) reviewState.active = json.session;
    setReviewRunning(false, json.message || json.error || '批注同步失败', true);
    renderReviewSession();
    return;
  }
  reviewState.active = json.session;
  const wb = json.writeback || {};
  setReviewRunning(false, '同步完成：新增 ' + (wb.created || []).length + '，更新 ' + (wb.updated || []).length + '，跳过 ' + (wb.skipped || []).length + '。');
  renderReviewSession();
  await loadComments();
  await loadReviewSessions(false);
}

async function decideFinding(findingId, decision) {
  const session = reviewState.active;
  if (!session || reviewState.running) return;
  const { json } = await apiJson('/api/review-sessions/' + encodeURIComponent(session.id) + '/findings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finding_id: findingId, decision }),
  });
  if (!json.ok) { toast(json.error || '更新 finding 失败', true); return; }
  reviewState.active = json.session;
  renderReviewSession();
}

function resetReviewComposer() {
  reviewState.active = null;
  $('review-instruction').value = '';
  setReviewRunning(false, '已准备新评审；设置重点后点击“开始完整评审”。');
  renderReviewSession();
}

// ---- wire up ------------------------------------------------------
function bind() {
  $('btn-edit').onclick = enterEdit;
  $('editor-save').onclick = saveDoc;
  $('editor-cancel').onclick = exitEdit;
  $('btn-comments').onclick = () => $('comment-sidebar').classList.toggle('open');
  $('btn-ai-review').onclick = startReview;
  $('btn-review-history').onclick = async () => {
    openReviewDrawer();
    if (!reviewState.active) await loadReviewSessions(true);
  };
  $('review-close').onclick = closeReviewDrawer;
  $('review-scrim').onclick = closeReviewDrawer;
  $('review-start').onclick = startReview;
  $('review-new').onclick = resetReviewComposer;
  $('review-writeback').onclick = syncReview;
  $('review-send').onclick = continueReview;
  $('review-message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); continueReview(); }
  });
  // Default path = block-level in-place editing (Apple-Notes feel): a plain
  // click on a rendered block turns it into a textarea of that block's source.
  ctx.el.detailMdContent.addEventListener('click', (e) => {
    if (state.isEditMode) return;                       // whole-source mode owns it
    if (e.target.closest('.comment-anchor-mark')) return;
    if (e.target.closest('.block-editor')) return;
    if (e.target.closest('a[href]')) return;            // let links work
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;                // non-collapsed = comment flow
    const wrap = e.target.closest('.doc-block');
    if (wrap && !wrap.classList.contains('editing')) enterBlockEdit(wrap);
  });
  ctx.el.detailEditor.addEventListener('input', function () {
    state.editorDirty = this.value !== state.savedBodyContent;
    setStatus(state.editorDirty ? 'dirty' : '', state.editorDirty ? '未保存' : '');
  });
  document.addEventListener('mouseup', () => setTimeout(onSelection, 0));
  $('sel-add-comment').onclick = () => {
    $('sel-popover').hidden = true;
    if (!pendingQuote) return;
    const content = prompt('批注内容（针对：「' + pendingQuote.quote_text.slice(0, 40) + '」）：', '');
    if (content == null || !content.trim()) return;
    createComment(pendingQuote, content.trim());
    window.getSelection().removeAllRanges();
  };
  $('sel-ask-ai').onclick = () => {
    $('sel-popover').hidden = true;
    openAi(pendingQuote ? pendingQuote.quote_text : '');
  };
  $('ai-close').onclick = () => { $('ai-modal').hidden = true; };
  $('ai-send').onclick = sendAi;
  document.addEventListener('mousedown', (e) => {
    const pop = $('sel-popover');
    if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
  });
}

// ---- boot ---------------------------------------------------------
const mathOk = installMathExtension();
if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
setupAnchor(ctx);
setupMarkdown(ctx);
window.__SPIKE__ = {
  ctx, mathOk, applyCommentAnchors, loadComments, renderPreview,
  get comments() { return comments; },
  get blockMap() { return blockMap; },
  segmentBlocks, enterBlockEdit,
  commitBlockEdit: (discard, opts) => commitBlockEdit(discard, opts),
  get activeBlockEditor() { return activeBlockEditor; },
  reviewState, renderReviewSession, startReview, syncReview,
};
bind();
loadDoc().then(() => loadReviewSessions(false));
