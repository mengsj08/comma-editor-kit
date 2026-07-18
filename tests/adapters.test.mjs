import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDocumentAdapter } from '../src/adapters/memory-adapter.js';
import { StorageDocumentAdapter } from '../src/adapters/storage-adapter.js';
import { RevisionConflictError } from '../src/core/revision.js';

test('memory adapter rejects stale writes and records actors', async () => {
  const adapter = new MemoryDocumentAdapter({ title: 'paper.md', body: '# One\n' });
  const first = await adapter.load();
  const saved = await adapter.save({ body: '# Two\n', baseRev: first.rev, actor: 'june' });
  assert.notEqual(saved.rev, first.rev);
  await assert.rejects(
    () => adapter.save({ body: '# Stale\n', baseRev: first.rev, actor: 'codex' }),
    RevisionConflictError,
  );
  const events = await adapter.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'june');
});

test('comments preserve quote locators through adapter round trips', async () => {
  const adapter = new MemoryDocumentAdapter({ body: 'A quoted sentence.' });
  const created = await adapter.createComment({
    content: 'Tighten this.',
    quoteText: 'quoted sentence',
    sourceLocator: { textIndex: 2 },
    actor: 'reviewer',
  });
  assert.equal(created.kind, 'anchored');
  assert.equal((await adapter.listComments())[0].sourceLocator.textIndex, 2);
  await adapter.deleteComment(created.id);
  assert.deepEqual(await adapter.listComments(), []);
});

test('memory adapter creates a revision-guarded comment batch atomically', async () => {
  const adapter = new MemoryDocumentAdapter({ body: 'Current source.' });
  const document = await adapter.load();
  const result = await adapter.createComments({
    baseRev: document.rev,
    actor: 'codex-review',
    source: 'ai-review',
    comments: [
      { quoteText: 'Current source.', content: 'Verify the claim.', priority: 'P0' },
      { kind: 'overall', content: 'Tighten the thesis.' },
    ],
  });
  assert.equal(result.comments.length, 2);
  assert.equal((await adapter.listComments())[0].source, 'ai-review');
  assert.equal((await adapter.listEvents()).at(-1).action, 'create-comment-batch');

  await assert.rejects(
    () => adapter.createComments({ baseRev: 'stale', comments: [{ content: 'Must not write.' }] }),
    RevisionConflictError,
  );
  assert.equal((await adapter.listComments()).length, 2);
});

test('storage adapter persists one canonical record', async () => {
  const records = new Map();
  const storage = {
    async get(key) { return records.get(key) || null; },
    async set(key, value) { records.set(key, structuredClone(value)); },
  };
  const adapterA = new StorageDocumentAdapter({ storage, key: 'doc', seed: { title: 'shared.md', body: 'v1' } });
  const initial = await adapterA.load();
  await adapterA.save({ body: 'v2', baseRev: initial.rev, actor: 'host-a' });
  const adapterB = new StorageDocumentAdapter({ storage, key: 'doc' });
  assert.equal((await adapterB.load()).body, 'v2');
});

test('storage adapter writes one complete comment batch in one record update', async () => {
  const records = new Map();
  let writes = 0;
  const storage = {
    async get(key) { return records.get(key) || null; },
    async set(key, value) { writes += 1; records.set(key, structuredClone(value)); },
  };
  const adapter = new StorageDocumentAdapter({ storage, key: 'review', seed: { body: 'Exact quote.' } });
  const document = await adapter.load();
  const writesBeforeBatch = writes;
  await adapter.createComments({
    baseRev: document.rev,
    actor: 'claude-review',
    comments: [
      { quoteText: 'Exact quote.', content: 'First.' },
      { quoteText: 'Exact quote.', content: 'Second.' },
    ],
  });
  assert.equal(writes, writesBeforeBatch + 1);
  assert.equal((await adapter.listComments()).length, 2);
});
