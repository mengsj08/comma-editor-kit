function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeComment(input = {}) {
  const quoteText = String(input.quoteText ?? input.quote_text ?? '').trim();
  const kind = input.kind === 'overall' || !quoteText ? 'overall' : 'anchored';
  const priority = String(input.priority || '').toUpperCase();
  return {
    id: String(input.id || randomId('comment')),
    kind,
    content: String(input.content || '').trim(),
    quoteText,
    sourceLocator: input.sourceLocator || input.source_locator || null,
    anchorState: String(input.anchorState || input.anchor_state || (kind === 'overall' ? 'overall' : 'unresolved')),
    section: String(input.section || '').trim(),
    priority: ['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : '',
    source: String(input.source || (String(input.actor || '').toLowerCase().includes('ai') ? 'ai-review' : 'manual')),
    actor: String(input.actor || 'user'),
    createdAt: String(input.createdAt || input.created_at || new Date().toISOString()),
    updatedAt: String(input.updatedAt || input.updated_at || new Date().toISOString()),
  };
}

export function createEditEvent({ actor = 'user', action, summary = '', revBefore = '', revAfter = '' }) {
  if (!action) throw new TypeError('EditEvent.action is required');
  return {
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
