import { RevisionConflictError } from '../core/revision.js';

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 409 || data.conflict) {
    throw new RevisionConflictError({
      expected: data.expected || '',
      actual: data.rev || data.actual || '',
      body: data.body || '',
    });
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }
  return data;
}

export class HttpDocumentAdapter {
  constructor({ documentUrl, commentsUrl, commentsBatchUrl = '', eventsUrl = '', assetUrl = '', headers = {} } = {}) {
    if (!documentUrl || !commentsUrl) throw new TypeError('documentUrl and commentsUrl are required');
    this.documentUrl = documentUrl;
    this.commentsUrl = commentsUrl;
    this.commentsBatchUrl = commentsBatchUrl;
    this.eventsUrl = eventsUrl;
    this.assetUrl = assetUrl;
    this.headers = { ...headers };
    this.capabilities = {
      savePolicy: 'immediate',
      document: { load: true, save: true, replace: false },
      comments: {
        list: true,
        create: true,
        batch: Boolean(commentsBatchUrl),
        update: true,
        delete: true,
      },
      events: { list: Boolean(eventsUrl) },
      assets: { resolve: Boolean(assetUrl) },
    };
  }

  _json(method, body) {
    return {
      method,
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
    };
  }

  async load() {
    const data = await requestJson(this.documentUrl, { headers: this.headers });
    return { title: data.title || data.path || 'document.md', body: data.body || '', rev: data.rev || '' };
  }

  async save({ body, baseRev, actor }) {
    const data = await requestJson(this.documentUrl, this._json('PUT', {
      body,
      base_rev: baseRev,
      actor,
    }));
    return { title: data.title || data.path || 'document.md', body: data.body ?? body, rev: data.rev || '' };
  }

  async listComments() {
    const data = await requestJson(this.commentsUrl, { headers: this.headers });
    return data.comments || [];
  }

  async createComment(comment) {
    const data = await requestJson(this.commentsUrl, this._json('POST', comment));
    return data.comment || (data.comments || []).at(-1);
  }

  async createComments({ comments, baseRev, actor, source }) {
    if (!this.commentsBatchUrl) {
      throw new Error('commentsBatchUrl is required for atomic comment batches');
    }
    const data = await requestJson(this.commentsBatchUrl, this._json('POST', {
      comments,
      base_rev: baseRev,
      actor,
      source,
    }));
    return { comments: data.comments || [], rev: data.rev || baseRev };
  }

  async updateComment(id, patch) {
    const data = await requestJson(this.commentsUrl, this._json('PUT', { id, ...patch }));
    return data.comment || (data.comments || []).find((comment) => comment.id === id);
  }

  async deleteComment(id) {
    await requestJson(this.commentsUrl, this._json('DELETE', { id }));
  }

  async listEvents() {
    if (!this.eventsUrl) return [];
    const data = await requestJson(this.eventsUrl, { headers: this.headers });
    return data.events || [];
  }

  resolveAsset({ src }) {
    const source = String(src || '').trim();
    if (!this.assetUrl || !source) return source;
    if (/^(?:https?:|data:|blob:)/i.test(source) || source.startsWith('//')) return source;
    const separator = this.assetUrl.includes('?') ? '&' : '?';
    return `${this.assetUrl}${separator}source=${encodeURIComponent(source)}`;
  }
}
