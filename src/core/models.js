function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export const COMMA_SCHEMAS = Object.freeze({
  document: 'comma-document/v1',
  comment: 'comma-comment/v1',
  finding: 'comma-finding/v1',
  reviewSession: 'comma-review-session/v1',
  writebackReceipt: 'comma-writeback-receipt/v1',
  editEvent: 'comma-edit-event/v1',
});

function first(input, ...keys) {
  for (const key of keys) {
    if (input?.[key] != null) return input[key];
  }
  return undefined;
}

function normalizedDecision(value) {
  const decision = String(value || 'proposed').trim().toLowerCase();
  return ['accepted', 'proposed', 'rejected'].includes(decision) ? decision : 'proposed';
}

export function normalizeDocument(input = {}) {
  return {
    schemaVersion: String(first(input, 'schemaVersion', 'schema_version') || COMMA_SCHEMAS.document),
    id: String(first(input, 'id', 'documentId', 'document_id', 'path') || ''),
    title: String(first(input, 'title', 'name', 'path') || 'untitled.md'),
    body: String(first(input, 'body', 'content') || ''),
    rev: String(first(input, 'rev', 'sha256', 'revision') || ''),
  };
}

export function normalizeComment(input = {}) {
  const quoteText = String(first(input, 'quoteText', 'quote_text') || '').trim();
  const kind = input.kind === 'overall' || !quoteText ? 'overall' : 'anchored';
  const priority = String(input.priority || '').toUpperCase();
  return {
    schemaVersion: String(first(input, 'schemaVersion', 'schema_version') || COMMA_SCHEMAS.comment),
    id: String(input.id || randomId('comment')),
    kind,
    content: String(input.content || '').trim(),
    quoteText,
    sourceLocator: first(input, 'sourceLocator', 'source_locator') || null,
    anchorState: String(first(input, 'anchorState', 'anchor_state') || (kind === 'overall' ? 'overall' : 'unresolved')),
    section: String(input.section || '').trim(),
    priority: ['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : '',
    source: String(input.source || (String(first(input, 'actor', 'author') || '').toLowerCase().includes('ai') ? 'ai-review' : 'manual')),
    actor: String(first(input, 'actor', 'author') || 'user'),
    sourceKey: String(first(input, 'sourceKey', 'source_key') || ''),
    findingId: String(first(input, 'findingId', 'finding_id') || ''),
    reviewSessionId: String(first(input, 'reviewSessionId', 'review_session_id') || ''),
    reviewState: String(first(input, 'reviewState', 'review_state') || 'active'),
    createdAt: String(first(input, 'createdAt', 'created_at') || new Date().toISOString()),
    updatedAt: String(first(input, 'updatedAt', 'updated_at') || new Date().toISOString()),
  };
}

export function normalizeFinding(input = {}, fallbackId = '') {
  const priority = String(input.priority || 'P2').toUpperCase();
  return {
    schemaVersion: String(first(input, 'schemaVersion', 'schema_version') || COMMA_SCHEMAS.finding),
    id: String(input.id || fallbackId || randomId('finding')),
    quoteText: String(first(input, 'quoteText', 'quote_text') || '').trim(),
    issue: String(input.issue || '').trim(),
    action: String(input.action || '').trim(),
    priority: ['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : 'P2',
    decision: normalizedDecision(input.decision),
    section: String(input.section || '').trim(),
    evidenceRequirement: String(first(input, 'evidenceRequirement', 'evidence_requirement') || '').trim(),
    rationale: String(input.rationale || '').trim(),
    anchorState: String(first(input, 'anchorState', 'anchor_state') || 'unresolved'),
    sourceLocator: first(input, 'sourceLocator', 'source_locator') || null,
    appliedCommentId: String(first(input, 'appliedCommentId', 'applied_comment_id') || ''),
    version: Math.max(1, Number(input.version || 1) || 1),
  };
}

export function normalizeWritebackReceipt(input = {}) {
  const list = (key) => Array.isArray(input[key]) ? clone(input[key]) : [];
  return {
    schemaVersion: String(first(input, 'schemaVersion', 'schema_version') || COMMA_SCHEMAS.writebackReceipt),
    id: String(input.id || randomId('receipt')),
    baseRev: String(first(input, 'baseRev', 'base_rev') || ''),
    created: list('created'),
    updated: list('updated'),
    skipped: list('skipped'),
    blocked: list('blocked'),
    at: String(first(input, 'at', 'createdAt', 'created_at') || new Date().toISOString()),
  };
}

export function normalizeReviewSession(input = {}) {
  return {
    schemaVersion: String(first(input, 'schemaVersion', 'schema_version') || COMMA_SCHEMAS.reviewSession),
    id: String(input.id || randomId('review')),
    documentId: String(first(input, 'documentId', 'document_id', 'docPath', 'doc_path') || ''),
    baseRev: String(first(input, 'baseRev', 'base_rev') || ''),
    documentRev: String(first(input, 'documentRev', 'document_rev') || first(input, 'baseRev', 'base_rev') || ''),
    tool: String(input.tool || ''),
    status: String(input.status || 'ready'),
    summary: String(input.summary || ''),
    findings: (Array.isArray(input.findings) ? input.findings : []).map((item, index) => normalizeFinding(item, `F${String(index + 1).padStart(3, '0')}`)),
    messages: clone(Array.isArray(input.messages) ? input.messages : []),
    writebackReceipts: (Array.isArray(first(input, 'writebackReceipts', 'writeback_receipts'))
      ? first(input, 'writebackReceipts', 'writeback_receipts') : []).map(normalizeWritebackReceipt),
    createdAt: String(first(input, 'createdAt', 'created_at') || ''),
    updatedAt: String(first(input, 'updatedAt', 'updated_at') || ''),
  };
}

export function createEditEvent({ actor = 'user', action, summary = '', revBefore = '', revAfter = '' }) {
  if (!action) throw new TypeError('EditEvent.action is required');
  return {
    schemaVersion: COMMA_SCHEMAS.editEvent,
    id: randomId('event'),
    at: new Date().toISOString(),
    actor: String(actor || 'user'),
    action: String(action),
    summary: String(summary || ''),
    revBefore: String(revBefore || ''),
    revAfter: String(revAfter || ''),
  };
}

export function clone(value) {
  return value == null ? value : structuredClone(value);
}
