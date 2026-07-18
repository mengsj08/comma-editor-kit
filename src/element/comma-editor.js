import katexCss from 'katex/dist/katex.min.css?inline';
import highlightCss from 'highlight.js/styles/github-dark.min.css?inline';
import componentCss from './comma-editor.css?inline';
import { createSourceLocator, normalizeQuoteText, resolveQuote } from '../core/anchors.js';
import { normalizeSavePolicy, resolveAdapterCapabilities } from '../core/adapter-contract.js';
import { replaceBlock, segmentMarkdown } from '../core/blocks.js';
import { previewCommentBatch as buildCommentBatchPreview } from '../core/comment-batch.js';
import { normalizeComment, normalizeDocument } from '../core/models.js';
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
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!ancestor || !root.contains(ancestor)) return null;
  const text = selection.toString().trim();
  return text ? { selection, range, text, ancestor } : null;
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

  get documentState() {
    return structuredClone({ ...this._document, dirty: this._dirty, savePolicy: this.savePolicy });
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
            <button class="ce-button" type="button" data-action="source" data-el="source-button">Source</button>
            <button class="ce-button primary" type="button" data-action="explicit-save" data-el="explicit-save" hidden>Save</button>
            <button class="ce-button review" type="button" data-action="ai-review" data-el="ai-review-button">AI review</button>
            <button class="ce-button" type="button" data-action="overall-comment" data-el="overall-comment-button">Overall note</button>
            <button class="ce-button" type="button" data-action="comments" data-el="comments-button">Comments <span class="ce-count" data-el="comment-count">0</span></button>
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
              <h2 class="ce-sidebar-title">Margin notes</h2>
              <span class="ce-sidebar-note">quote anchored</span>
            </div>
            <div class="ce-comments" data-el="comments"></div>
          </aside>
        </div>
        <div class="ce-status" data-el="status"><span class="ce-status-dot"></span><span data-el="status-text">Waiting</span></div>
      </section>
      <div class="ce-selection-bar" data-el="selection-bar" hidden>
        <button type="button" data-action="selection-comment">Add note</button>
        <button type="button" data-action="selection-ai">Ask AI</button>
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
      if (action === 'source') this._enterSource();
      if (action === 'explicit-save') await this.save();
      if (action === 'ai-review') this.requestAiReview();
      if (action === 'cancel-source') this._exitSource();
      if (action === 'save-source') await this._saveSource();
      if (action === 'comments') this._el('sidebar').toggleAttribute('hidden');
      if (action === 'overall-comment') this._openCommentComposer(null);
      if (action === 'selection-comment') this._openCommentComposer(this._selection);
      if (action === 'selection-ai') this._askAi();
      if (action === 'cancel-comment') this._closeCommentComposer();
      if (action === 'save-comment') await this._saveComment();
      if (action === 'delete-comment') await this._deleteComment(event.target.dataset.commentId);
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
    if (comment) {
      this._jumpToComment(comment.dataset.commentId);
      return;
    }
    const block = event.target.closest('.ce-block');
    if (block && !this.readonly && !this._selection && !event.target.closest('a, button, input, textarea')) {
      this._enterBlockEdit(Number(block.dataset.blockIndex));
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
    this._el('comment-count').textContent = String(this._comments.length);
    const writable = !this.readonly && this._capabilities.document.save;
    this._el('source-button').hidden = !writable;
    this._el('explicit-save').hidden = this.savePolicy !== 'explicit' || !writable;
    this._el('explicit-save').disabled = !this._dirty;
    this._el('ai-review-button').hidden = this.hasAttribute('hide-ai-review');
    this._el('ai-review-button').disabled = this._dirty || this.readonly;
    this._el('overall-comment-button').hidden = !this._capabilities.comments.create;
    this._el('comments-button').hidden = !this._capabilities.comments.list;
    this._el('sidebar').hidden = !this._capabilities.comments.list;
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
    for (const block of this._blocks) {
      const wrapper = document.createElement('section');
      wrapper.className = 'ce-block';
      wrapper.dataset.blockIndex = String(block.index);
      wrapper.dataset.blockType = block.type;
      wrapper.innerHTML = this._renderer.render(block.raw, { resolveAsset });
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
    wrapper.replaceChildren(textarea);
    this._activeBlock = { block, wrapper, textarea, trailer };
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(90, textarea.scrollHeight + 2), innerHeight * 0.75)}px`;
    };
    textarea.addEventListener('input', resize);
    textarea.addEventListener('blur', () => this._commitBlock(false));
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
    const blockElement = captured.ancestor.closest('.ce-block');
    const blockIndex = Number(blockElement?.dataset.blockIndex ?? -1);
    const locator = createSourceLocator(this._document.body, captured.text, {
      rev: this._document.rev,
      blockIndex,
    });
    this._selection = { quoteText: captured.text, sourceLocator: locator };
    this.shadowRoot.querySelector('[data-action="selection-comment"]').hidden = !this._capabilities.comments.create || this._dirty;
    this.shadowRoot.querySelector('[data-action="selection-ai"]').hidden = this.hasAttribute('hide-ai-review') || this._dirty;
    const rect = captured.range.getBoundingClientRect();
    bar.style.left = `${rect.left + rect.width / 2}px`;
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
    this._el('comment-count').textContent = String(this._comments.length);
    if (!this._comments.length) {
      root.innerHTML = '<div class="ce-comment-empty">Select a sentence to leave a margin note. The note keeps a quote snapshot if the source later moves.</div>';
      return;
    }
    root.innerHTML = this._comments.map((comment) => {
      const resolution = comment.kind === 'overall' ? { state: 'overall' } : this._resolveComment(comment);
      const state = comment.reviewState === 'withdrawn' || comment.reviewState === 'pending'
        ? comment.reviewState : resolution.state;
      return `<article class="ce-comment ${escapeHtml(comment.reviewState)}" data-comment-id="${escapeHtml(comment.id)}">
        <button class="ce-comment-delete" type="button" data-action="delete-comment" data-comment-id="${escapeHtml(comment.id)}" aria-label="Delete comment">×</button>
        <span class="ce-comment-state ${escapeHtml(state)}">${escapeHtml(state)}</span>
        ${comment.priority ? `<span class="ce-comment-priority">${escapeHtml(comment.priority)}</span>` : ''}
        ${comment.quoteText ? `<p class="ce-comment-quote">“${escapeHtml(comment.quoteText)}”</p>` : ''}
        <p class="ce-comment-body">${escapeHtml(comment.content)}</p>
        <div class="ce-comment-meta">${escapeHtml(comment.actor)}${comment.section ? ` · ${escapeHtml(comment.section)}` : ''} · ${escapeHtml(comment.createdAt.slice(0, 16).replace('T', ' '))}</div>
      </article>`;
    }).join('');
  }

  _applyCommentAnchors() {
    const preview = this._el('preview');
    preview.querySelectorAll('.ce-block').forEach((block) => {
      block.classList.remove('has-comment');
      block.querySelectorAll('.ce-block-badge').forEach((badge) => badge.remove());
    });
    const counts = new Map();
    for (const comment of this._comments) {
      if (comment.kind !== 'anchored' || comment.reviewState === 'withdrawn') continue;
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
    if (Number.isInteger(recorded) && recorded >= 0) {
      const element = blockElements.find((block) => Number(block.dataset.blockIndex) === recorded);
      if (element && normalizeQuoteText(element.textContent).includes(needle)) {
        return { state: 'rendered-block', index: -1, blockIndex: recorded };
      }
    }
    const candidates = blockElements.filter((element) => normalizeQuoteText(element.textContent).includes(needle));
    if (candidates.length === 1) {
      return { state: 'rendered-unique', index: -1, blockIndex: Number(candidates[0].dataset.blockIndex) };
    }
    return { state: candidates.length > 1 ? 'ambiguous' : 'missing', index: -1, blockIndex: -1 };
  }

  async _deleteComment(id) {
    if (!id || !this._adapter?.deleteComment || this.readonly) return;
    if (!globalThis.confirm?.('Delete this comment?')) return;
    try {
      await this._adapter.deleteComment(id);
      this._comments = this._comments.filter((comment) => comment.id !== id);
      this._renderComments();
      this._applyCommentAnchors();
      this._renderMeta();
    } catch (error) {
      this._setStatus('error', error.message || 'Delete failed');
    }
  }

  _askAi() {
    if (!this._selection) return;
    if (this._dirty) {
      this._setStatus('error', 'Save the draft before asking AI');
      return;
    }
    this._el('selection-bar').hidden = true;
    this._emit('comma-ai-request', {
      ...structuredClone(this._selection),
      document: this.documentState,
      actor: this.actor,
    });
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
