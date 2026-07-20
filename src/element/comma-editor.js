import katexCss from 'katex/dist/katex.min.css?inline';
import highlightCss from 'highlight.js/styles/github-dark.min.css?inline';
import componentCss from './comma-editor.css?inline';
import { createSourceLocator, normalizeQuoteText, resolveQuote } from '../core/anchors.js';
import { normalizeSavePolicy, resolveAdapterCapabilities } from '../core/adapter-contract.js';
import { replaceBlock, segmentMarkdown } from '../core/blocks.js';
import { previewCommentBatch as buildCommentBatchPreview } from '../core/comment-batch.js';
import {
  isCommentVisible,
  normalizeComment,
  normalizeDocument,
} from '../core/models.js';
import { RevisionConflictError } from '../core/revision.js';
import { MarkdownRenderer } from './markdown-renderer.js';

const EMPTY_DOCUMENT = { title: 'untitled.md', body: '', rev: '' };

const COMMENT_BATCH_SCHEMA = {
  type: 'object',
  required: ['base_rev', 'comments'],
  properties: {
    base_rev: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['quote_text', 'content'],
        properties: {
          quote_text: { type: 'string', description: 'An exact substring from the Markdown source' },
          content: { type: 'string' },
          section: { type: 'string' },
          priority: { enum: ['P0', 'P1', 'P2', 'P3'] },
        },
      },
    },
  },
};

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return `review_${globalThis.crypto.randomUUID()}`;
  return `review_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trailingNewlines(value) {
  return String(value || '').match(/\n*$/)?.[0] || '';
}

function selectionInside(root) {
  const selection = globalThis.getSelection?.();
  const text = selection?.toString().trim() || '';
  if (!selection || !text) return null;

  let range = null;
  const selectionRoot = root.getRootNode();
  if (selectionRoot instanceof ShadowRoot && typeof selection.getComposedRanges === 'function') {
    try {
      const [composed] = selection.getComposedRanges({ shadowRoots: [selectionRoot] });
      if (composed) {
        range = root.ownerDocument.createRange();
        range.setStart(composed.startContainer, composed.startOffset);
        range.setEnd(composed.endContainer, composed.endOffset);
      }
    } catch {
      range = null;
    }
  }
  if (!range && selection.rangeCount) range = selection.getRangeAt(0);
  if (!range) return null;

  const elementFor = (node) => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const startElement = elementFor(range.startContainer);
  const endElement = elementFor(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;
  const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!ancestor) return null;
  return { selection, range, text, ancestor, startElement, endElement };
}

function readableBlockText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.ce-block-edit-action, .ce-block-badge').forEach((control) => control.remove());
  return normalizeQuoteText(clone.textContent);
}

export class CommaEditorElement extends HTMLElement {
  static observedAttributes = ['actor', 'readonly', 'save-policy', 'hide-ai-review'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._adapter = null;
    this._capabilities = resolveAdapterCapabilities(null);
    this._renderer = new MarkdownRenderer();
    this._document = { ...EMPTY_DOCUMENT };
    this._persistedBody = '';
    this._dirty = false;
    this._comments = [];
    this._blocks = [];
    this._activeBlock = null;
    this._selection = null;
    this._selectionActions = [{ id: 'ask-ai', label: 'Ask AI' }];
    this._toolbarActions = [];
    this._commentActions = [];
    this._showWithdrawnComments = false;
    this._commentsRev = '';
    this._inlineCommentAction = null;
    this._commentDetails = null;
    this._sourceMode = false;
    this._commentBatchPreview = null;
    this._loading = false;
    this._connected = false;
  }

  connectedCallback() {
    if (this._connected) return;
    this._connected = true;
    this._renderShell();
    this._bind();
    if (this._adapter) this.load();
  }

  attributeChangedCallback() {
    if (this._connected) this._renderMeta();
  }

  set adapter(value) {
    this._adapter = value;
    this._capabilities = resolveAdapterCapabilities(value);
    if (this._connected && value) queueMicrotask(() => this.load());
  }

  get adapter() {
    return this._adapter;
  }

  get actor() {
    return this.getAttribute('actor') || 'user';
  }

  get readonly() {
    return this.hasAttribute('readonly');
  }

  get savePolicy() {
    return normalizeSavePolicy(this.getAttribute('save-policy') || this._capabilities.savePolicy);
  }

  get dirty() {
    return this._dirty;
  }

  get capabilities() {
    return structuredClone(this._capabilities);
  }

  set selectionActions(value) {
    const rows = Array.isArray(value) ? value : [];
    this._selectionActions = rows.slice(0, 6).map((action) => ({
      id: String(action?.id || '').trim(),
      label: String(action?.label || action?.id || '').trim(),
      title: String(action?.title || '').trim(),
    })).filter((action) => action.id && action.label);
    if (this._connected) this._renderSelectionActions();
  }

  get selectionActions() {
    return structuredClone(this._selectionActions);
  }

  set toolbarActions(value) {
    const rows = Array.isArray(value) ? value : [];
    this._toolbarActions = rows.slice(0, 16).map((action) => ({
      id: String(action?.id || '').trim(),
      label: String(action?.label || action?.id || '').trim(),
      title: String(action?.title || '').trim(),
      slot: action?.slot === 'overflow' ? 'overflow' : 'primary',
      appliesTo: structuredClone(action?.appliesTo ?? null),
      count: String(action?.count || '').trim(),
    })).filter((action) => action.id && action.label);
    if (this._connected) this._renderToolbarActions();
  }

  get toolbarActions() {
    return structuredClone(this._toolbarActions);
  }

  set commentActions(value) {
    const rows = Array.isArray(value) ? value : [];
    this._commentActions = rows.slice(0, 16).map((action) => ({
      id: String(action?.id || '').trim(),
      label: String(action?.label || action?.id || '').trim(),
      title: String(action?.title || '').trim(),
      appliesTo: structuredClone(action?.appliesTo ?? 'comments.list'),
    })).filter((action) => action.id && action.label);
    if (this._connected) this._renderComments();
  }

  get commentActions() {
    return structuredClone(this._commentActions);
  }

  set showWithdrawnComments(value) {
    this._showWithdrawnComments = Boolean(value);
    if (this._connected) {
      this._renderComments();
      this._applyCommentAnchors();
      this._renderMeta();
    }
  }

  get showWithdrawnComments() {
    return this._showWithdrawnComments;
  }

  get commentsRev() {
    return this._commentsRev;
  }

  get documentState() {
    return structuredClone({ ...this._document, dirty: this._dirty, savePolicy: this.savePolicy });
  }

  openSourceEditor() {
    this._enterSource();
  }

  openOverallCommentComposer() {
    this._openCommentComposer(null);
  }

  toggleComments(force) {
    if (!this._capabilities.comments.list) return false;
    const sidebar = this._el('sidebar');
    sidebar.hidden = typeof force === 'boolean' ? !force : !sidebar.hidden;
    return !sidebar.hidden;
  }

  jumpToComment(id) {
    return this._jumpToComment(id);
  }

  openCommentAction(commentId, options = {}) {
    const comment = this._comments.find((item) => item.id === commentId);
    if (!comment) return false;
    const replyId = String(options.replyId || '');
    const reply = replyId ? comment.replies.find((item) => item.id === replyId) : null;
    this._inlineCommentAction = {
      commentId,
      replyId,
      actionId: String(options.actionId || ''),
      label: String(options.label || ''),
      placeholder: String(options.placeholder || ''),
      submitLabel: String(options.submitLabel || 'Save'),
      initialValue: String(options.initialValue ?? reply?.content ?? comment.content ?? ''),
    };
    this._commentDetails = null;
    this._renderComments();
    queueMicrotask(() => this.shadowRoot.querySelector('[data-el="comment-action-input"]')?.focus());
    return true;
  }

  closeCommentAction() {
    this._inlineCommentAction = null;
    if (this._connected) this._renderComments();
  }

  showCommentDetails(commentId, { label = 'History', items = [] } = {}) {
    if (!this._comments.some((item) => item.id === commentId)) return false;
    this._commentDetails = {
      commentId,
      label: String(label || 'History'),
      items: structuredClone(Array.isArray(items) ? items : []),
    };
    this._inlineCommentAction = null;
    this._renderComments();
    return true;
  }

  requestAiReview() {
    if (this.readonly || !this._document.rev) return null;
    if (this._dirty) {
      this._setStatus('error', 'Save the draft before AI review');
      return null;
    }
    const requestId = createRequestId();
    const detail = {
      requestId,
      mode: 'comment-batch',
      scope: 'document',
      document: this.documentState,
      actor: this.actor,
      outputSchema: structuredClone(COMMENT_BATCH_SCHEMA),
      instructions: 'Return exact Markdown quotes. Do not rewrite the document. Each proposed comment must explain a concrete issue or action.',
      accept: (response, options = {}) => this.previewCommentBatch(response, {
        requestId,
        actor: options.actor || 'ai-review',
        source: options.source || 'ai-review',
      }),
    };
    this._emit('comma-ai-request', detail);
    this._setStatus('saving', 'Review request sent to host');
    return requestId;
  }

  previewCommentBatch(input = {}, options = {}) {
    const payload = Array.isArray(input) ? { comments: input } : (input || {});
    const baseRev = String(payload.baseRev ?? payload.base_rev ?? this._document.rev ?? '');
    if (baseRev !== this._document.rev) {
      throw new RevisionConflictError({ expected: baseRev, actual: this._document.rev, body: this._document.body });
    }
    const preview = buildCommentBatchPreview({
      body: this._document.body,
      rev: this._document.rev,
      comments: payload.comments || [],
    });
    this._commentBatchPreview = {
      ...preview,
      actor: String(options.actor || payload.actor || 'ai-review'),
      source: String(options.source || payload.source || 'ai-review'),
      requestId: String(options.requestId || payload.requestId || payload.request_id || ''),
      items: preview.items.map((item) => ({ ...item, selected: item.status === 'ready' })),
    };
    this._renderReviewQueue();
    this._el('review-queue').hidden = false;
    this._setStatus('saved', `${preview.counts.ready} comments ready for review`);
    this._emit('comma-comment-batch-preview', { preview: structuredClone(this._commentBatchPreview) });
    return structuredClone(this._commentBatchPreview);
  }

  async load() {
    if (!this._adapter || this._loading) return;
    this._loading = true;
    this._setStatus('saving', 'Loading document');
    try {
      this._capabilities = resolveAdapterCapabilities(this._adapter);
      const documentState = normalizeDocument(await this._adapter.load());
      this._document = documentState;
      this._persistedBody = documentState.body;
      this._dirty = false;
      this._comments = this._capabilities.comments.list
        ? (await this._adapter.listComments()).map(normalizeComment)
        : [];
      this._commentsRev = this._capabilities.comments.list ? String(this._adapter.commentsRev || '') : '';
      this._inlineCommentAction = null;
      this._commentDetails = null;
      this._sourceMode = false;
      this._closeReviewQueue();
      this._renderDocument();
      this._setStatus('saved', 'Ready');
      this._emit('comma-ready', { document: this.documentState, comments: structuredClone(this._comments) });
    } catch (error) {
      this._setStatus('error', error.message || 'Could not load document');
      this._emit('comma-error', { phase: 'load', error });
    } finally {
      this._loading = false;
    }
  }

  async replaceDocument({ title, body, actor = this.actor }) {
    if (!this._adapter) throw new Error('No document adapter configured');
    if (typeof this._adapter.replace === 'function') {
      this._document = normalizeDocument(await this._adapter.replace({ title, body, actor }));
      this._comments = this._capabilities.comments.list ? await this._adapter.listComments() : [];
      this._commentsRev = this._capabilities.comments.list ? String(this._adapter.commentsRev || '') : '';
    } else {
      const saved = await this._adapter.save({ body, baseRev: this._document.rev, actor });
      this._document = normalizeDocument({ ...saved, title: title || saved.title });
    }
    this._persistedBody = this._document.body;
    this._dirty = false;
    this._closeReviewQueue();
    this._renderDocument();
    return this.documentState;
  }

  async refreshComments() {
    if (!this._capabilities.comments.list) return [];
    this._comments = (await this._adapter.listComments()).map(normalizeComment);
    this._commentsRev = String(this._adapter.commentsRev || this._commentsRev || '');
    this._inlineCommentAction = null;
    this._commentDetails = null;
    this._renderComments();
    this._applyCommentAnchors();
    this._renderMeta();
    return structuredClone(this._comments);
  }

  async save() {
    if (this.readonly || !this._capabilities.document.save) return false;
    if (!this._dirty) return true;
    return this._persistBody(this._document.body);
  }

  discardChanges() {
    if (!this._dirty) return false;
    this._document.body = this._persistedBody;
    this._dirty = false;
    this._sourceMode = false;
    this._closeReviewQueue();
    this._renderDocument();
    this._setStatus('saved', 'Draft discarded');
    this._emit('comma-discard', { document: this.documentState });
    return true;
  }

  jumpToQuote(quoteText, sourceLocator = {}) {
    const comment = normalizeComment({ quoteText, sourceLocator, content: '', actor: 'host' });
    return this._jumpToResolvedComment(comment);
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>${katexCss}\n${highlightCss}\n${componentCss}</style>
      <section class="ce-shell" aria-label="Comma Markdown editor">
        <header class="ce-header">
          <div class="ce-identity">
            <div class="ce-kicker">Comma Editor</div>
            <h1 class="ce-title" data-el="title">untitled.md</h1>
            <div class="ce-meta" data-el="meta">No document loaded</div>
          </div>
          <div class="ce-actions">
            <span class="ce-toolbar-primary" data-el="toolbar-primary"></span>
            <button class="ce-button primary" type="button" data-action="explicit-save" data-el="explicit-save" hidden>Save</button>
            <details class="ce-toolbar-overflow" data-el="toolbar-overflow" hidden>
              <summary class="ce-button" aria-label="More actions">···</summary>
              <div class="ce-toolbar-overflow-menu" data-el="toolbar-overflow-menu"></div>
            </details>
          </div>
        </header>
        <div class="ce-grid">
          <main class="ce-document">
            <div class="ce-preview" data-el="preview"></div>
            <div class="ce-source-pane" data-el="source-pane" hidden>
              <textarea class="ce-source-editor" data-el="source-editor" spellcheck="false" aria-label="Markdown source"></textarea>
              <div class="ce-source-actions">
                <button class="ce-button" type="button" data-action="cancel-source">Cancel</button>
                <button class="ce-button primary" type="button" data-action="save-source">Save source</button>
              </div>
            </div>
          </main>
          <aside class="ce-sidebar" data-el="sidebar">
            <div class="ce-sidebar-head">
              <h2 class="ce-sidebar-title" data-el="comment-panel-title">Comments</h2>
              <span class="ce-sidebar-note">quote anchored</span>
            </div>
            <div class="ce-comments" data-el="comments"></div>
          </aside>
        </div>
        <div class="ce-status" data-el="status"><span class="ce-status-dot"></span><span data-el="status-text">Waiting</span></div>
      </section>
      <div class="ce-selection-bar" data-el="selection-bar" hidden>
        <button type="button" data-action="selection-comment">Add note</button>
        <span class="ce-selection-divider" data-el="selection-divider"></span>
        <span class="ce-selection-host-actions" data-el="selection-host-actions"></span>
      </div>
      <section class="ce-composer" data-el="composer" hidden aria-label="New comment">
        <div class="ce-composer-label" data-el="composer-label">New margin note</div>
        <div class="ce-composer-quote" data-el="composer-quote"></div>
        <textarea class="ce-comment-input" data-el="comment-input" placeholder="What should change, and why?"></textarea>
        <div class="ce-composer-actions">
          <button class="ce-button" type="button" data-action="cancel-comment">Cancel</button>
          <button class="ce-button primary" type="button" data-action="save-comment">Add note</button>
        </div>
      </section>
      <section class="ce-review-queue" data-el="review-queue" hidden aria-label="AI comment review queue">
        <header class="ce-review-head">
          <div>
            <div class="ce-review-kicker">Structured review</div>
            <h2>Comment queue</h2>
          </div>
          <button class="ce-review-close" type="button" data-action="close-review" aria-label="Close review queue">×</button>
        </header>
        <div class="ce-review-summary" data-el="review-summary"></div>
        <div class="ce-review-items" data-el="review-items"></div>
        <footer class="ce-review-actions">
          <span data-el="review-hint">Nothing is written until you confirm.</span>
          <div>
            <button class="ce-button" type="button" data-action="close-review">Cancel</button>
            <button class="ce-button primary" type="button" data-action="apply-review" data-el="apply-review">Add ready notes</button>
          </div>
        </footer>
      </section>
      <section class="ce-lightbox" data-el="lightbox" data-action="close-lightbox" hidden aria-label="Image preview">
        <button class="ce-lightbox-close" type="button" data-action="close-lightbox" data-el="lightbox-close" aria-label="Close image preview">×</button>
        <img data-el="lightbox-image" alt="">
        <div class="ce-lightbox-caption" data-el="lightbox-caption"></div>
      </section>`;
    this._renderSelectionActions();
    this._renderToolbarActions();
  }

  _el(name) {
    return this.shadowRoot.querySelector(`[data-el="${name}"]`);
  }

  _bind() {
    this.shadowRoot.addEventListener('click', (event) => this._onClick(event));
    this._el('preview').addEventListener('mouseup', () => queueMicrotask(() => this._captureSelection()));
    this._el('preview').addEventListener('keyup', () => queueMicrotask(() => this._captureSelection()));
    this._el('comment-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this._saveComment();
      }
    });
    this._el('source-editor').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this._saveSource();
      }
      if (event.key === 'Escape') this._exitSource();
    });
    this._el('preview').addEventListener('error', (event) => {
      if (event.target instanceof HTMLImageElement && event.target.dataset.assetState !== 'resolving') {
        this._replaceImageWithFallback(event.target);
      }
    }, true);
    this.shadowRoot.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this._el('lightbox').hidden) this._closeImageLightbox();
    });
  }

  async _onClick(event) {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) {
      if (action !== 'toggle-review-item') event.preventDefault();
      if (action === 'toolbar-action') this._runToolbarAction(event.target.closest('[data-toolbar-action]')?.dataset.toolbarAction);
      if (action === 'comment-action') this._runCommentAction(
        event.target.closest('[data-comment-action]')?.dataset.commentAction,
        event.target.closest('[data-comment-id]')?.dataset.commentId,
        event.target.closest('[data-reply-id]')?.dataset.replyId || '',
      );
      if (action === 'cancel-comment-action') this.closeCommentAction();
      if (action === 'submit-comment-action') this._submitCommentAction();
      if (action === 'close-comment-details') {
        this._commentDetails = null;
        this._renderComments();
      }
      if (action === 'explicit-save') await this.save();
      if (action === 'cancel-source') this._exitSource();
      if (action === 'save-source') await this._saveSource();
      if (action === 'selection-comment') this._openCommentComposer(this._selection);
      if (action === 'selection-action') this._runSelectionAction(event.target.closest('[data-selection-action]')?.dataset.selectionAction);
      if (action === 'edit-block') this._enterBlockEdit(Number(event.target.closest('[data-block-index]')?.dataset.blockIndex));
      if (action === 'cancel-block-edit') await this._commitBlock(true);
      if (action === 'commit-block-edit') await this._commitBlock(false);
      if (action === 'cancel-comment') this._closeCommentComposer();
      if (action === 'save-comment') await this._saveComment();
      if (action === 'close-review') this._closeReviewQueue();
      if (action === 'toggle-review-item') this._toggleReviewItem(event.target.dataset.proposalId, event.target.checked);
      if (action === 'apply-review') await this._applyCommentBatch();
      if (action === 'close-lightbox') this._closeImageLightbox();
      return;
    }

    const image = event.target.closest('.ce-preview img');
    if (image) {
      event.preventDefault();
      this._openImageLightbox(image);
      return;
    }

    const comment = event.target.closest('.ce-comment');
    if (comment && !event.target.closest('.ce-comment-menu, .ce-comment-inline, .ce-comment-details, .ce-reply')) {
      this._jumpToComment(comment.dataset.commentId);
      return;
    }
  }

  _renderDocument() {
    this._renderMeta();
    this._el('source-pane').hidden = true;
    this._el('preview').hidden = false;
    this._renderPreview();
    this._renderComments();
  }

  _renderMeta() {
    if (!this._connected) return;
    this._el('title').textContent = this._document.title || 'untitled.md';
    const lines = this._document.body ? this._document.body.split('\n').length : 0;
    const revision = this._document.rev ? this._document.rev.replace('sha256-', '').slice(0, 8) : '—';
    const policy = this.savePolicy === 'explicit' ? 'explicit save' : 'immediate save';
    const mode = this.readonly ? 'read only' : `${policy} · actor ${this.actor}`;
    const dirty = this._dirty ? ' · unsaved' : '';
    this._el('meta').textContent = `${lines} lines · rev ${revision} · ${mode}${dirty}`;
    const writable = !this.readonly && this._capabilities.document.save;
    this._el('explicit-save').hidden = this.savePolicy !== 'explicit' || !writable;
    this._el('explicit-save').disabled = !this._dirty;
    this._el('sidebar').hidden = !this._capabilities.comments.list;
    this._renderToolbarActions();
  }

  _renderPreview() {
    const preview = this._el('preview');
    preview.replaceChildren();
    this._activeBlock = null;
    this._blocks = segmentMarkdown((source) => this._renderer.lexer(source), this._document.body);
    if (!this._blocks.length) {
      preview.innerHTML = '<div class="ce-empty"><p>This document is empty.</p><p>Open Source mode to begin writing.</p></div>';
      return;
    }
    const assetDocument = this.documentState;
    const resolveAsset = this._capabilities.assets?.resolve && this._adapter?.resolveAsset
      ? (src) => this._adapter.resolveAsset({ src, document: assetDocument })
      : null;
    const writable = !this.readonly && this._capabilities.document.save;
    const editLabel = this.lang?.toLowerCase().startsWith('zh') ? '编辑本段' : 'Edit block';
    for (const block of this._blocks) {
      const wrapper = document.createElement('section');
      wrapper.className = 'ce-block';
      wrapper.dataset.blockIndex = String(block.index);
      wrapper.dataset.blockType = block.type;
      wrapper.innerHTML = this._renderer.render(block.raw, { resolveAsset });
      if (writable) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'ce-block-edit-action';
        editButton.dataset.action = 'edit-block';
        editButton.textContent = editLabel;
        editButton.setAttribute('aria-label', editLabel);
        editButton.title = editLabel;
        wrapper.appendChild(editButton);
      }
      preview.appendChild(wrapper);
    }
    this._applyCommentAnchors();
    this._hydrateScientificContent(preview);
    this._renderer.hydrate(preview).catch((error) => this._emit('comma-error', { phase: 'render-mermaid', error }));
  }

  _hydrateScientificContent(preview) {
    preview.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('ce-table-scroll')) return;
      const scroller = document.createElement('div');
      scroller.className = 'ce-table-scroll';
      table.replaceWith(scroller);
      scroller.appendChild(table);
    });

    const images = Array.from(preview.querySelectorAll('img'));
    for (const image of images) {
      image.dataset.originalSrc = image.dataset.originalSrc || image.getAttribute('src') || '';
      image.dataset.assetState = 'loading';
      this._promoteImageFigure(image);
      if (image.complete) {
        if (image.naturalWidth > 0) image.dataset.assetState = 'ready';
        else this._replaceImageWithFallback(image);
      } else {
        image.addEventListener('load', () => { image.dataset.assetState = 'ready'; }, { once: true });
      }
    }
  }

  _promoteImageFigure(image) {
    const paragraph = image.closest('p');
    if (!paragraph || paragraph.textContent.trim() || paragraph.childElementCount !== 1) return;
    const media = paragraph.firstElementChild;
    if (media !== image && !(media?.matches('a') && media.querySelector(':scope > img') === image)) return;
    const figure = document.createElement('figure');
    paragraph.replaceWith(figure);
    figure.appendChild(media);
    const caption = String(image.getAttribute('alt') || '').trim();
    if (caption) {
      const figcaption = document.createElement('figcaption');
      figcaption.textContent = caption;
      figure.appendChild(figcaption);
    }
  }

  _replaceImageWithFallback(image, reason = '') {
    if (!image?.isConnected || image.dataset.assetState === 'failed') return;
    image.dataset.assetState = 'failed';
    const source = image.dataset.originalSrc || image.getAttribute('src') || '';
    const fallback = document.createElement('a');
    fallback.className = 'ce-image-fallback';
    fallback.href = image.getAttribute('src') || source || '#';
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.textContent = reason
      ? `Image unavailable: ${reason}`
      : `Image unavailable: ${image.alt || source || 'unnamed image'}`;
    image.replaceWith(fallback);
  }

  _openImageLightbox(image) {
    if (!image?.src || image.dataset.assetState === 'failed') return;
    this._el('lightbox-image').src = image.currentSrc || image.src;
    this._el('lightbox-image').alt = image.alt || '';
    this._el('lightbox-caption').textContent = image.alt || image.dataset.originalSrc || '';
    this._el('lightbox').hidden = false;
    this._el('lightbox-close').focus?.();
  }

  _closeImageLightbox() {
    this._el('lightbox').hidden = true;
    this._el('lightbox-image').removeAttribute('src');
    this._el('lightbox-caption').textContent = '';
  }

  _enterBlockEdit(index) {
    if (this._activeBlock || this._sourceMode || this.readonly) return;
    const block = this._blocks.find((item) => item.index === index);
    const wrapper = this._el('preview').querySelector(`[data-block-index="${index}"]`);
    if (!block || !wrapper) return;
    const trailer = trailingNewlines(block.raw);
    const textarea = document.createElement('textarea');
    textarea.className = 'ce-block-editor';
    textarea.value = block.raw.slice(0, block.raw.length - trailer.length);
    textarea.spellcheck = false;
    const zh = this.lang?.toLowerCase().startsWith('zh');
    textarea.setAttribute('aria-label', zh ? '编辑本段 Markdown' : 'Edit block Markdown');
    const editing = document.createElement('div');
    editing.className = 'ce-block-editing';
    const footer = document.createElement('div');
    footer.className = 'ce-block-edit-footer';
    const hint = document.createElement('span');
    hint.textContent = zh ? 'Esc 取消 · ⌘/Ctrl + Enter 完成' : 'Esc cancel · ⌘/Ctrl + Enter done';
    const actions = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel-block-edit';
    cancel.textContent = zh ? '取消' : 'Cancel';
    const done = document.createElement('button');
    done.type = 'button';
    done.dataset.action = 'commit-block-edit';
    done.className = 'primary';
    done.textContent = zh ? '完成' : 'Done';
    actions.append(cancel, done);
    footer.append(hint, actions);
    editing.append(textarea, footer);
    wrapper.replaceChildren(editing);
    this._selection = null;
    this._el('selection-bar').hidden = true;
    this._activeBlock = { block, wrapper, textarea, trailer, editing };
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(90, textarea.scrollHeight + 2), innerHeight * 0.75)}px`;
    };
    textarea.addEventListener('input', resize);
    textarea.addEventListener('blur', (event) => {
      if (!editing.contains(event.relatedTarget)) this._commitBlock(false);
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this._commitBlock(true);
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this._commitBlock(false);
      }
    });
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    resize();
  }

  async _commitBlock(discard) {
    const active = this._activeBlock;
    if (!active) return;
    this._activeBlock = null;
    if (discard) {
      this._renderPreview();
      return;
    }
    const replacement = active.textarea.value + active.trailer;
    if (replacement === active.block.raw) {
      this._renderPreview();
      return;
    }
    const nextBody = replaceBlock(this._document.body, active.block, replacement);
    await this._applyBody(nextBody);
  }

  _enterSource() {
    if (this.readonly) return;
    this._sourceMode = true;
    this._el('source-editor').value = this._document.body;
    this._el('preview').hidden = true;
    this._el('source-pane').hidden = false;
    this._el('source-editor').focus();
  }

  _exitSource() {
    this._sourceMode = false;
    this._el('source-pane').hidden = true;
    this._el('preview').hidden = false;
  }

  async _saveSource() {
    const body = this._el('source-editor').value;
    if (body === this._document.body) {
      this._exitSource();
      return;
    }
    const saved = await this._applyBody(body);
    if (saved) this._exitSource();
  }

  async _applyBody(body) {
    const nextBody = String(body ?? '');
    if (this.savePolicy === 'explicit') {
      this._document.body = nextBody;
      this._dirty = nextBody !== this._persistedBody;
      this._closeReviewQueue();
      this._renderDocument();
      this._setStatus(this._dirty ? 'saving' : 'saved', this._dirty ? 'Unsaved draft' : 'Ready');
      this._emit('comma-change', { document: this.documentState, actor: this.actor });
      return true;
    }
    return this._persistBody(nextBody);
  }

  async _persistBody(body) {
    if (!this._adapter) {
      this._setStatus('error', 'No adapter configured');
      return false;
    }
    this._setStatus('saving', 'Saving');
    try {
      const saved = await this._adapter.save({ body, baseRev: this._document.rev, actor: this.actor });
      this._document = normalizeDocument({ ...saved, title: saved.title || this._document.title, body: saved.body ?? body });
      this._persistedBody = this._document.body;
      this._dirty = false;
      this._closeReviewQueue();
      this._renderDocument();
      this._setStatus('saved', 'Saved');
      this._emit('comma-save', { document: this.documentState, actor: this.actor });
      return true;
    } catch (error) {
      if (error instanceof RevisionConflictError || error?.code === 'REVISION_CONFLICT') {
        this._document.body = error.body;
        this._document.rev = error.actual;
        this._persistedBody = error.body;
        this._dirty = false;
        this._renderDocument();
        this._setStatus('error', 'Conflict: reloaded latest');
        this._emit('comma-conflict', { error, document: this.documentState });
      } else {
        this._setStatus('error', error.message || 'Save failed');
        this._emit('comma-error', { phase: 'save', error });
      }
      return false;
    }
  }

  _captureSelection() {
    const captured = selectionInside(this._el('preview'));
    const bar = this._el('selection-bar');
    if (!captured) {
      this._selection = null;
      bar.hidden = true;
      return;
    }
    const blockElement = captured.startElement.closest('.ce-block');
    const endBlockElement = captured.endElement.closest('.ce-block');
    const blockIndex = Number(blockElement?.dataset.blockIndex ?? -1);
    const endBlockIndex = Number(endBlockElement?.dataset.blockIndex ?? blockIndex);
    const sourceBlock = this._blocks.find((block) => block.index === blockIndex);
    const endSourceBlock = this._blocks.find((block) => block.index === endBlockIndex);
    const locator = createSourceLocator(this._document.body, captured.text, {
      rev: this._document.rev,
      blockIndex,
      endBlockIndex,
      blockStart: sourceBlock?.start,
      blockEnd: endSourceBlock?.end ?? sourceBlock?.end,
    });
    this._selection = { quoteText: captured.text, sourceLocator: locator };
    this.shadowRoot.querySelector('[data-action="selection-comment"]').hidden = !this._capabilities.comments.create || this._dirty;
    this._el('selection-host-actions').hidden = this.hasAttribute('hide-ai-review') || this._dirty || !this._selectionActions.length;
    this._el('selection-divider').hidden = this._el('selection-host-actions').hidden
      || this.shadowRoot.querySelector('[data-action="selection-comment"]').hidden;
    const rect = captured.range.getBoundingClientRect();
    bar.style.left = `${Math.min(globalThis.innerWidth - 24, Math.max(24, rect.left + rect.width / 2))}px`;
    bar.style.top = `${Math.max(44, rect.top)}px`;
    bar.hidden = false;
  }

  _openCommentComposer(selection) {
    if (this.readonly || !this._capabilities.comments.create) return;
    if (this._dirty) {
      this._setStatus('error', 'Save the draft before adding comments');
      return;
    }
    this._selection = selection || null;
    this._el('selection-bar').hidden = true;
    this._el('composer-label').textContent = selection ? 'Anchored margin note' : 'Overall note';
    this._el('composer-quote').textContent = selection?.quoteText || 'Applies to the whole document';
    this._el('comment-input').value = '';
    this._el('composer').hidden = false;
    this._el('comment-input').focus();
  }

  _closeCommentComposer() {
    this._el('composer').hidden = true;
    this._selection = null;
  }

  async _saveComment() {
    const content = this._el('comment-input').value.trim();
    if (!content || !this._adapter?.createComment) return;
    const selection = this._selection;
    try {
      const comment = await this._adapter.createComment({
        kind: selection ? 'anchored' : 'overall',
        content,
        quoteText: selection?.quoteText || '',
        sourceLocator: selection?.sourceLocator || null,
        anchorState: selection ? 'unresolved' : 'overall',
        actor: this.actor,
      });
      this._comments.push(normalizeComment(comment));
      this._commentsRev = String(this._adapter.commentsRev || this._commentsRev || '');
      this._closeCommentComposer();
      this._renderComments();
      this._applyCommentAnchors();
      this._renderMeta();
      this._emit('comma-comment-create', { comment: normalizeComment(comment) });
    } catch (error) {
      this._setStatus('error', error.message || 'Comment failed');
    }
  }

  _renderReviewQueue() {
    const preview = this._commentBatchPreview;
    if (!preview || !this._connected) return;
    const blocked = preview.counts.ambiguous + preview.counts.missing + preview.counts.invalid;
    const selected = preview.items.filter((item) => item.status === 'ready' && item.selected).length;
    this._el('review-summary').innerHTML = `
      <div><strong>${preview.counts.ready}</strong><span>ready</span></div>
      <div class="${blocked ? 'needs-attention' : ''}"><strong>${blocked}</strong><span>needs attention</span></div>
      <p>Anchors are checked against revision <code>${escapeHtml(preview.baseRev.replace('sha256-', '').slice(0, 8))}</code>.</p>`;
    this._el('review-items').innerHTML = preview.items.map((item) => {
      const comment = item.comment;
      const ready = item.status === 'ready';
      const meta = [comment.priority, comment.section].filter(Boolean).map(escapeHtml).join(' · ');
      return `<article class="ce-review-item ${escapeHtml(item.status)}">
        <div class="ce-review-item-head">
          <label class="ce-review-check">
            <input type="checkbox" data-action="toggle-review-item" data-proposal-id="${escapeHtml(item.proposalId)}" ${ready && item.selected ? 'checked' : ''} ${ready ? '' : 'disabled'}>
            <span>${ready ? 'include' : 'blocked'}</span>
          </label>
          <span class="ce-review-state">${escapeHtml(item.status)}</span>
        </div>
        ${meta ? `<div class="ce-review-meta">${meta}</div>` : ''}
        ${comment.quoteText ? `<blockquote>${escapeHtml(comment.quoteText)}</blockquote>` : '<blockquote>Whole document</blockquote>'}
        <p>${escapeHtml(comment.content)}</p>
        <small>${escapeHtml(item.reason)}</small>
      </article>`;
    }).join('') || '<div class="ce-review-empty">The host returned no comment proposals.</div>';
    this._el('apply-review').disabled = selected === 0;
    this._el('apply-review').textContent = selected ? `Add ${selected} ready note${selected === 1 ? '' : 's'}` : 'No ready notes';
    this._el('review-hint').textContent = blocked
      ? `${blocked} blocked proposal${blocked === 1 ? '' : 's'} will not be written.`
      : 'Nothing is written until you confirm.';
  }

  _toggleReviewItem(proposalId, selected) {
    const item = this._commentBatchPreview?.items.find((candidate) => candidate.proposalId === proposalId);
    if (!item || item.status !== 'ready') return;
    item.selected = Boolean(selected);
    this._renderReviewQueue();
  }

  _closeReviewQueue() {
    this._commentBatchPreview = null;
    if (this._connected && this._el('review-queue')) this._el('review-queue').hidden = true;
  }

  async _applyCommentBatch() {
    const preview = this._commentBatchPreview;
    if (!preview) return;
    if (this._dirty) {
      this._setStatus('error', 'Save the draft before writing comments');
      return;
    }
    if (!this._adapter?.createComments) {
      this._setStatus('error', 'Adapter does not support atomic comment batches');
      return;
    }
    if (preview.baseRev !== this._document.rev) {
      const error = new RevisionConflictError({
        expected: preview.baseRev,
        actual: this._document.rev,
        body: this._document.body,
      });
      this._setStatus('error', 'Review is stale; request a fresh review');
      this._emit('comma-conflict', { error, document: this.documentState });
      return;
    }
    const comments = preview.items
      .filter((item) => item.status === 'ready' && item.selected)
      .map((item) => item.comment);
    if (!comments.length) return;
    this._el('apply-review').disabled = true;
    this._setStatus('saving', 'Writing comment batch');
    try {
      const result = await this._adapter.createComments({
        comments,
        baseRev: preview.baseRev,
        actor: preview.actor,
        source: preview.source,
      });
      const created = (result.comments || []).map(normalizeComment);
      this._comments.push(...created);
      this._commentsRev = String(this._adapter.commentsRev || this._commentsRev || '');
      const detail = {
        comments: structuredClone(created),
        baseRev: preview.baseRev,
        requestId: preview.requestId,
        source: preview.source,
      };
      this._closeReviewQueue();
      this._renderComments();
      this._applyCommentAnchors();
      this._renderMeta();
      this._setStatus('saved', `${created.length} review comments added`);
      this._emit('comma-comment-batch-create', detail);
    } catch (error) {
      if (error instanceof RevisionConflictError || error?.code === 'REVISION_CONFLICT') {
        this._setStatus('error', 'Review is stale; no comments were written');
        this._emit('comma-conflict', { error, document: this.documentState });
      } else {
        this._setStatus('error', error.message || 'Comment batch failed');
        this._emit('comma-error', { phase: 'comment-batch', error });
      }
      this._renderReviewQueue();
    }
  }

  _renderComments() {
    const root = this._el('comments');
    const visibleComments = this._comments.filter((comment) => isCommentVisible(comment, {
      showWithdrawn: this._showWithdrawnComments,
    }));
    this._renderToolbarActions();
    if (!visibleComments.length) {
      root.innerHTML = '<div class="ce-comment-empty">Select a sentence to leave a margin note. The note keeps a quote snapshot if the source later moves.</div>';
      return;
    }
    root.innerHTML = visibleComments.map((comment) => {
      const resolution = comment.kind === 'overall' ? { state: 'overall' } : this._resolveComment(comment);
      const lifecycleWithdrawn = comment.lifecycleState === 'withdrawn';
      const findingWithdrawn = comment.findingState === 'withdrawn';
      const findingStatus = ['provisional', 'pending'].includes(comment.findingState) ? comment.findingState : '';
      const state = lifecycleWithdrawn ? 'withdrawn' : findingWithdrawn ? 'finding withdrawn' : findingStatus || resolution.state;
      const cardClass = lifecycleWithdrawn ? 'lifecycle-withdrawn' : findingWithdrawn ? 'finding-withdrawn' : comment.findingState;
      return `<article class="ce-comment ${escapeHtml(cardClass)}" data-comment-id="${escapeHtml(comment.id)}">
        ${this._renderCommentMenu(comment)}
        <span class="ce-comment-state ${escapeHtml(state.replace(/\s+/g, '-'))}">${escapeHtml(state)}</span>
        ${comment.priority ? `<span class="ce-comment-priority">${escapeHtml(comment.priority)}</span>` : ''}
        ${comment.humanEdited ? '<span class="ce-comment-human-edited">human edited</span>' : ''}
        ${comment.quoteText ? `<p class="ce-comment-quote">“${escapeHtml(comment.quoteText)}”</p>` : ''}
        <p class="ce-comment-body">${escapeHtml(comment.content)}</p>
        <div class="ce-comment-meta">${escapeHtml(comment.actor)}${comment.section ? ` · ${escapeHtml(comment.section)}` : ''} · v${comment.commentVersion} · ${escapeHtml(comment.createdAt.slice(0, 16).replace('T', ' '))}</div>
        ${this._renderCommentReplies(comment)}
        ${this._renderInlineCommentAction(comment)}
        ${this._renderCommentDetails(comment)}
      </article>`;
    }).join('');
  }

  _renderCommentMenu(comment, reply = null) {
    if (!this._capabilities.comments.list) return '';
    const actions = this._commentActions.filter((action) => this._commentActionAvailable(action, comment, reply));
    if (!actions.length) return '';
    const replyAttribute = reply ? ` data-reply-id="${escapeHtml(reply.id)}"` : '';
    return `<details class="ce-comment-menu"${replyAttribute}>
      <summary aria-label="Comment actions">···</summary>
      <div>${actions.map((action) => `<button type="button" data-action="comment-action" data-comment-action="${escapeHtml(action.id)}"${action.title ? ` title="${escapeHtml(action.title)}"` : ''}>${escapeHtml(action.label)}</button>`).join('')}</div>
    </details>`;
  }

  _renderCommentReplies(comment) {
    const replies = comment.replies.filter((reply) => this._showWithdrawnComments || reply.state !== 'withdrawn');
    if (!replies.length) return '';
    return `<div class="ce-replies">${replies.map((reply) => `<article class="ce-reply ${escapeHtml(reply.state)}" data-reply-id="${escapeHtml(reply.id)}">
      ${this._renderCommentMenu(comment, reply)}
      <p>${escapeHtml(reply.content)}</p>
      <div>${escapeHtml(reply.actor)} · ${escapeHtml(reply.updatedAt.slice(0, 16).replace('T', ' '))}${reply.state === 'withdrawn' ? ' · withdrawn' : ''}</div>
    </article>`).join('')}</div>`;
  }

  _renderInlineCommentAction(comment) {
    const state = this._inlineCommentAction;
    if (!state || state.commentId !== comment.id) return '';
    return `<section class="ce-comment-inline">
      ${state.label ? `<strong>${escapeHtml(state.label)}</strong>` : ''}
      <textarea data-el="comment-action-input" placeholder="${escapeHtml(state.placeholder)}">${escapeHtml(state.initialValue)}</textarea>
      <div><button type="button" data-action="cancel-comment-action">Cancel</button><button class="primary" type="button" data-action="submit-comment-action">${escapeHtml(state.submitLabel)}</button></div>
    </section>`;
  }

  _renderCommentDetails(comment) {
    const details = this._commentDetails;
    if (!details || details.commentId !== comment.id) return '';
    const items = details.items.map((item) => `<li>
      <strong>${escapeHtml(item.action || '')}</strong>
      <span>${escapeHtml(item.actor || '')} · ${escapeHtml(String(item.at || '').replace('T', ' ').slice(0, 19))}</span>
      <small>v${escapeHtml(item.fromVersion ?? item.from_version ?? 0)} → v${escapeHtml(item.toVersion ?? item.to_version ?? 0)}</small>
    </li>`).join('');
    return `<section class="ce-comment-details"><header><strong>${escapeHtml(details.label)}</strong><button type="button" data-action="close-comment-details">×</button></header><ol>${items || '<li>No recorded changes.</li>'}</ol></section>`;
  }

  _applyCommentAnchors() {
    const preview = this._el('preview');
    preview.querySelectorAll('.ce-block').forEach((block) => {
      block.classList.remove('has-comment');
      block.querySelectorAll('.ce-block-badge').forEach((badge) => badge.remove());
    });
    const counts = new Map();
    for (const comment of this._comments) {
      if (comment.kind !== 'anchored' || !isCommentVisible(comment, {
        showWithdrawn: this._showWithdrawnComments,
      })) continue;
      const resolution = this._resolveComment(comment);
      if (!Number.isInteger(resolution.blockIndex) || resolution.blockIndex < 0) continue;
      counts.set(resolution.blockIndex, (counts.get(resolution.blockIndex) || 0) + 1);
    }
    for (const [index, count] of counts) {
      const block = preview.querySelector(`[data-block-index="${index}"]`);
      if (!block) continue;
      block.classList.add('has-comment');
      const badge = document.createElement('span');
      badge.className = 'ce-block-badge';
      badge.textContent = String(count);
      badge.title = `${count} anchored comment${count === 1 ? '' : 's'}`;
      block.appendChild(badge);
    }
  }

  _jumpToComment(id) {
    const comment = this._comments.find((item) => item.id === id);
    if (!comment || comment.kind === 'overall') return;
    return this._jumpToResolvedComment(comment);
  }

  _jumpToResolvedComment(comment) {
    const resolution = this._resolveComment(comment);
    if (!Number.isInteger(resolution.blockIndex) || resolution.blockIndex < 0) {
      this._setStatus('error', resolution.state === 'ambiguous' ? 'Anchor is ambiguous' : 'Quoted source changed');
      return false;
    }
    const target = this._el('preview').querySelector(`[data-block-index="${resolution.blockIndex}"]`);
    if (!target) return false;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('is-flash');
    setTimeout(() => target.classList.remove('is-flash'), 1400);
    return true;
  }

  _resolveComment(comment) {
    const raw = resolveQuote(this._document.body, comment.quoteText, comment.sourceLocator || {}, this._document.rev);
    if (raw.index >= 0) {
      const sourceBlock = this._blocks.find((block) => raw.index >= block.start && raw.index < block.end);
      if (sourceBlock) return { ...raw, blockIndex: sourceBlock.index };
    }

    // Rendered selections can omit Markdown syntax (for example **bold**). If
    // raw-source matching fails, resolve against rendered block text. Preserve
    // the explicit block index when it still contains the quote; otherwise only
    // accept one unique rendered candidate and never guess among duplicates.
    const needle = normalizeQuoteText(comment.quoteText);
    if (!needle) return { state: 'missing', index: -1, blockIndex: -1 };
    const blockElements = Array.from(this._el('preview').querySelectorAll('.ce-block'));
    const recorded = Number(comment.sourceLocator?.blockIndex ?? comment.sourceLocator?.block_index);
    const recordedEnd = Number(comment.sourceLocator?.endBlockIndex ?? comment.sourceLocator?.end_block_index ?? recorded);
    if (Number.isInteger(recorded) && recorded >= 0) {
      const element = blockElements.find((block) => Number(block.dataset.blockIndex) === recorded);
      if (element && recordedEnd === recorded && readableBlockText(element).includes(needle)) {
        return { state: 'rendered-block', index: -1, blockIndex: recorded };
      }
      if (Number.isInteger(recordedEnd) && recordedEnd > recorded) {
        const rangeElements = blockElements.filter((block) => {
          const index = Number(block.dataset.blockIndex);
          return index >= recorded && index <= recordedEnd;
        });
        const rangeText = normalizeQuoteText(rangeElements.map(readableBlockText).join(' '));
        if (rangeElements.length && rangeText.includes(needle)) {
          return { state: 'rendered-range', index: -1, blockIndex: recorded, endBlockIndex: recordedEnd };
        }
      }
    }
    const candidates = blockElements.filter((element) => readableBlockText(element).includes(needle));
    if (candidates.length === 1) {
      return { state: 'rendered-unique', index: -1, blockIndex: Number(candidates[0].dataset.blockIndex) };
    }
    return { state: candidates.length > 1 ? 'ambiguous' : 'missing', index: -1, blockIndex: -1 };
  }

  _capabilityAvailable(appliesTo, defaultGroup = 'comments') {
    if (appliesTo == null || appliesTo === '') return true;
    if (Array.isArray(appliesTo)) {
      return appliesTo.every((item) => this._capabilityAvailable(item, defaultGroup));
    }
    const raw = typeof appliesTo === 'object' ? appliesTo.capability : appliesTo;
    if (!raw) return true;
    const [group, name] = String(raw).includes('.')
      ? String(raw).split('.', 2)
      : [defaultGroup, String(raw)];
    return Boolean(this._capabilities?.[group]?.[name]);
  }

  _toolbarActionAvailable(action) {
    if (!this._capabilityAvailable(action.appliesTo, 'document')) return false;
    const rules = typeof action.appliesTo === 'object' ? action.appliesTo : {};
    if (rules.requiresWritable && (this.readonly || !this._capabilities.document.save)) return false;
    return true;
  }

  _commentActionAvailable(action, comment, reply = null) {
    if (!this._capabilityAvailable(action.appliesTo, 'comments')) return false;
    const rules = typeof action.appliesTo === 'object' ? action.appliesTo : {};
    const target = String(rules.target || 'comment');
    if ((target === 'reply') !== Boolean(reply)) return false;
    const state = reply?.state || comment.lifecycleState;
    if (Array.isArray(rules.states) && !rules.states.includes(state)) return false;
    if (Array.isArray(rules.lifecycleStates) && !rules.lifecycleStates.includes(comment.lifecycleState)) return false;
    if (Array.isArray(rules.findingStates) && !rules.findingStates.includes(comment.findingState)) return false;
    if (Array.isArray(rules.kinds) && !rules.kinds.includes(comment.kind)) return false;
    return true;
  }

  _renderToolbarActions() {
    if (!this._connected || !this._el('toolbar-primary')) return;
    const available = this._toolbarActions.filter((action) => this._toolbarActionAvailable(action));
    const createButton = (action, overflow = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = overflow ? '' : 'ce-button';
      button.dataset.action = 'toolbar-action';
      button.dataset.toolbarAction = action.id;
      button.append(document.createTextNode(action.label));
      if (action.count === 'comments') {
        const count = this._comments.filter((comment) => isCommentVisible(comment, {
          showWithdrawn: this._showWithdrawnComments,
        })).length;
        const badge = document.createElement('span');
        badge.className = 'ce-count';
        badge.dataset.el = 'comment-count';
        badge.dataset.commentCount = '';
        badge.textContent = String(count);
        button.append(' ', badge);
      }
      if (action.title) button.title = action.title;
      const rules = typeof action.appliesTo === 'object' ? action.appliesTo : {};
      button.disabled = Boolean(rules.requiresCleanDocument && this._dirty);
      return button;
    };
    const primary = available.filter((action) => action.slot === 'primary');
    const overflow = available.filter((action) => action.slot === 'overflow');
    this._el('toolbar-primary').replaceChildren(...primary.map((action) => createButton(action)));
    this._el('toolbar-overflow-menu').replaceChildren(...overflow.map((action) => createButton(action, true)));
    this._el('toolbar-overflow').hidden = !overflow.length;
    const commentCountAction = available.find((action) => action.count === 'comments');
    this._el('comment-panel-title').textContent = commentCountAction?.label || 'Comments';
  }

  _runToolbarAction(actionId) {
    const action = this._toolbarActions.find((candidate) => candidate.id === actionId);
    if (!action || !this._toolbarActionAvailable(action)) return;
    this._el('toolbar-overflow').removeAttribute('open');
    this._emit('comma-toolbar-action', {
      actionId: action.id,
      action: structuredClone(action),
      document: this.documentState,
      actor: this.actor,
      commentsRev: this._commentsRev,
      commentCount: this._comments.filter((comment) => isCommentVisible(comment, {
        showWithdrawn: this._showWithdrawnComments,
      })).length,
      showWithdrawn: this._showWithdrawnComments,
    });
  }

  _runCommentAction(actionId, commentId, replyId = '') {
    const action = this._commentActions.find((candidate) => candidate.id === actionId);
    const comment = this._comments.find((candidate) => candidate.id === commentId);
    const reply = replyId ? comment?.replies.find((candidate) => candidate.id === replyId) : null;
    if (!action || !comment || !this._commentActionAvailable(action, comment, reply)) return;
    this._emit('comma-comment-action', {
      phase: 'activate',
      actionId: action.id,
      action: structuredClone(action),
      commentId: comment.id,
      replyId,
      comment: structuredClone(comment),
      reply: reply ? structuredClone(reply) : null,
      baseCommentVersion: comment.commentVersion,
      commentsRev: this._commentsRev,
      document: this.documentState,
      actor: this.actor,
    });
  }

  _submitCommentAction() {
    const state = this._inlineCommentAction;
    const content = this._el('comment-action-input')?.value.trim() || '';
    if (!state || !content) return;
    const comment = this._comments.find((candidate) => candidate.id === state.commentId);
    const reply = state.replyId ? comment?.replies.find((candidate) => candidate.id === state.replyId) : null;
    if (!comment) return;
    this._emit('comma-comment-action', {
      phase: 'submit',
      actionId: state.actionId,
      commentId: comment.id,
      replyId: state.replyId,
      content,
      comment: structuredClone(comment),
      reply: reply ? structuredClone(reply) : null,
      baseCommentVersion: comment.commentVersion,
      commentsRev: this._commentsRev,
      document: this.documentState,
      actor: this.actor,
    });
  }

  _renderSelectionActions() {
    if (!this._connected) return;
    const root = this._el('selection-host-actions');
    root.replaceChildren(...this._selectionActions.map((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = 'selection-action';
      button.dataset.selectionAction = action.id;
      button.textContent = action.label;
      if (action.title) button.title = action.title;
      return button;
    }));
    root.hidden = !this._selectionActions.length;
  }

  _runSelectionAction(actionId) {
    if (!this._selection) return;
    if (this._dirty) {
      this._setStatus('error', 'Save the draft before asking AI');
      return;
    }
    this._el('selection-bar').hidden = true;
    const action = this._selectionActions.find((candidate) => candidate.id === actionId);
    if (!action) return;
    const detail = {
      actionId: action.id,
      action: structuredClone(action),
      ...structuredClone(this._selection),
      document: this.documentState,
      actor: this.actor,
    };
    this._emit('comma-selection-action', detail);
    if (action.id === 'ask-ai') this._emit('comma-ai-request', { ...detail, mode: 'selection' });
    this._selection = null;
  }

  _setStatus(kind, text) {
    if (!this._connected) return;
    const status = this._el('status');
    status.className = `ce-status ${kind || ''}`;
    this._el('status-text').textContent = text || '';
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

export function registerCommaEditor(tagName = 'comma-editor') {
  if (!customElements.get(tagName)) customElements.define(tagName, CommaEditorElement);
  return customElements.get(tagName);
}
