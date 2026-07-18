const METHOD_CAPABILITIES = Object.freeze({
  load: ['document', 'load'],
  save: ['document', 'save'],
  replace: ['document', 'replace'],
  listComments: ['comments', 'list'],
  createComment: ['comments', 'create'],
  createComments: ['comments', 'batch'],
  updateComment: ['comments', 'update'],
  deleteComment: ['comments', 'delete'],
  listEvents: ['events', 'list'],
});

export const COMMA_ADAPTER_SCHEMA = 'comma-document-adapter/v1';
export const SAVE_POLICIES = Object.freeze(['immediate', 'explicit']);

function methodAvailable(adapter, name) {
  return typeof adapter?.[name] === 'function';
}

function explicitCapability(adapter, group, name) {
  const value = adapter?.capabilities?.[group]?.[name];
  return typeof value === 'boolean' ? value : null;
}

export function normalizeSavePolicy(value, fallback = 'explicit') {
  const normalized = String(value || '').trim().toLowerCase();
  return SAVE_POLICIES.includes(normalized) ? normalized : fallback;
}

export function resolveAdapterCapabilities(adapter) {
  const result = {
    schemaVersion: COMMA_ADAPTER_SCHEMA,
    document: { load: false, save: false, replace: false },
    comments: { list: false, create: false, batch: false, update: false, delete: false },
    events: { list: false },
    savePolicy: normalizeSavePolicy(adapter?.capabilities?.savePolicy || adapter?.savePolicy),
  };
  for (const [method, [group, name]] of Object.entries(METHOD_CAPABILITIES)) {
    const declared = explicitCapability(adapter, group, name);
    result[group][name] = declared == null ? methodAvailable(adapter, method) : declared && methodAvailable(adapter, method);
  }
  return result;
}

export function assertDocumentAdapter(adapter, { writable = false } = {}) {
  const capabilities = resolveAdapterCapabilities(adapter);
  if (!capabilities.document.load) throw new TypeError('DocumentAdapter.load() is required');
  if (writable && !capabilities.document.save) throw new TypeError('Writable DocumentAdapter.save() is required');
  return capabilities;
}
