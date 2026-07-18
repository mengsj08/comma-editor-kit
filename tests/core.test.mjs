import assert from 'node:assert/strict';
import test from 'node:test';
import { marked } from 'marked';
import {
  createSourceLocator,
  findQuoteMatches,
  normalizeQuoteText,
  resolveQuote,
} from '../src/core/anchors.js';
import { replaceBlock, segmentMarkdown } from '../src/core/blocks.js';
import { previewCommentBatch } from '../src/core/comment-batch.js';
import { revisionOf } from '../src/core/revision.js';
import {
  normalizeFinding,
  normalizeConversationSession,
  normalizeReviewSession,
  normalizeWritebackReceipt,
} from '../src/core/models.js';
import { assertDocumentAdapter, resolveAdapterCapabilities } from '../src/core/adapter-contract.js';

test('revision is deterministic and content-sensitive', async () => {
  assert.equal(await revisionOf('alpha'), await revisionOf('alpha'));
  assert.notEqual(await revisionOf('alpha'), await revisionOf('beta'));
});

test('conversation models preserve quote scope, branch lineage, notes, and writeback identity', () => {
  const session = normalizeConversationSession({
    id: 'conversation-1', doc_path: 'paper.md', base_rev: 'r1',
    source_quote: { quote_text: 'Exact passage.', source_locator: { text_index: 14 } },
    messages: [{
      id: 'm2', role: 'assistant', content: 'Scoped answer', parent_id: 'm1',
      branch_id: 'branch-a', branch_from_message_id: 'm0', writeback_comment_id: 'c-1',
    }, { id: 'n1', role: 'note', content: 'PI note', note_for_message_id: 'm2' }],
  });
  assert.equal(session.documentId, 'paper.md');
  assert.equal(session.sourceQuote.quoteText, 'Exact passage.');
  assert.equal(session.messages[0].parentId, 'm1');
  assert.equal(session.messages[0].branchFromMessageId, 'm0');
  assert.equal(session.messages[0].writebackCommentId, 'c-1');
  assert.equal(session.messages[1].noteForMessageId, 'm2');
});

test('block segmentation reconstructs source byte-for-byte', () => {
  const source = '# Title\n\nParagraph with $x$.\n\n```js\nconst a = 1;\n```\n';
  const blocks = segmentMarkdown(marked.lexer, source);
  assert.ok(blocks.length >= 3);
  for (const block of blocks) assert.equal(source.slice(block.start, block.end), block.raw);
  const target = blocks.find((block) => block.type === 'paragraph');
  const changed = replaceBlock(source, target, target.raw.replace('Paragraph', 'Edited paragraph'));
  assert.equal(changed, source.slice(0, target.start) + target.raw.replace('Paragraph', 'Edited paragraph') + source.slice(target.end));
});

test('anchors resolve unique, contextual, ambiguous, and missing quotes', () => {
  const body = 'First repeated phrase.\n\nMiddle.\n\nSecond repeated phrase.';
  const quote = 'repeated phrase';
  assert.deepEqual(findQuoteMatches(body, quote).length, 2);
  const locator = createSourceLocator(body, quote, { rev: 'old' });
  locator.prefix = 'First ';
  locator.suffix = '.\n\nMiddle';
  assert.equal(resolveQuote(body, quote, locator, 'new').state, 'context');
  assert.equal(resolveQuote(body, quote, {}, 'new').state, 'ambiguous');
  assert.equal(resolveQuote(body, 'Middle', {}, 'new').state, 'unique');
  assert.equal(resolveQuote(body, 'absent', {}, 'new').state, 'missing');
  assert.equal(normalizeQuoteText(' a\n  b '), 'a b');
});

test('selection locators disambiguate repeated quotes through the selected source block', () => {
  const body = 'Repeated phrase.\n\nMiddle.\n\nRepeated phrase.';
  const secondStart = body.lastIndexOf('Repeated phrase.');
  const locator = createSourceLocator(body, 'Repeated phrase.', {
    rev: 'same', blockIndex: 2, blockStart: secondStart, blockEnd: body.length,
  });
  assert.equal(locator.textIndex, secondStart);
  assert.equal(locator.occurrenceIndex, 1);
  assert.equal(resolveQuote(body, 'Repeated phrase.', locator, 'same').index, secondStart);
});

test('comment batch preview separates ready, ambiguous, missing, and invalid proposals', () => {
  const body = '# Review\n\nUnique sentence.\n\nRepeated phrase.\n\nRepeated phrase.\n';
  const preview = previewCommentBatch({
    body,
    rev: 'sha256-current',
    comments: [
      { quote_text: 'Unique sentence.', content: 'Add evidence.', priority: 'p0' },
      { quote_text: 'Repeated phrase.', content: 'Clarify this.' },
      { quote_text: 'Absent sentence.', content: 'Cannot anchor.' },
      { quote_text: 'Unique sentence.', content: '' },
      { kind: 'overall', content: 'Strengthen the central thesis.' },
    ],
  });
  assert.deepEqual(preview.counts, { total: 5, ready: 2, ambiguous: 1, missing: 1, invalid: 1 });
  const anchored = preview.items[0];
  assert.equal(anchored.status, 'ready');
  assert.equal(anchored.comment.priority, 'P0');
  assert.equal(anchored.comment.sourceLocator.textIndex, body.indexOf('Unique sentence.'));
  assert.equal(preview.items[1].matches.length, 2);
  assert.equal(preview.items[4].comment.kind, 'overall');
});

test('comment batch preview rejects duplicate proposals without guessing', () => {
  const input = { quote_text: 'One.', content: 'Check.' };
  const preview = previewCommentBatch({ body: 'One.', rev: 'r1', comments: [input, input] });
  assert.equal(preview.counts.ready, 1);
  assert.equal(preview.counts.invalid, 1);
  assert.match(preview.items[1].reason, /Duplicate/);
});

test('review models normalize legacy snake_case without losing writeback identity', () => {
  const finding = normalizeFinding({
    id: 'F001', quote_text: 'Exact quote.', evidence_requirement: 'PMID',
    anchor_state: 'ready', applied_comment_id: 'c-1', decision: 'accepted',
  });
  assert.equal(finding.quoteText, 'Exact quote.');
  assert.equal(finding.appliedCommentId, 'c-1');
  const receipt = normalizeWritebackReceipt({ base_rev: 'r1', created: ['c-1'], skipped: ['F002'] });
  assert.equal(receipt.baseRev, 'r1');
  const session = normalizeReviewSession({
    id: 'review-1', doc_path: 'paper.md', base_rev: 'r1', findings: [finding],
    writeback_receipts: [receipt],
  });
  assert.equal(session.documentId, 'paper.md');
  assert.equal(session.findings[0].id, 'F001');
  assert.equal(session.writebackReceipts.length, 1);
});

test('adapter capabilities distinguish a valid document-only host', () => {
  const adapter = { async load() { return {}; }, async save() { return {}; } };
  const capabilities = assertDocumentAdapter(adapter, { writable: true });
  assert.equal(capabilities.document.save, true);
  assert.equal(capabilities.comments.create, false);
  assert.equal(capabilities.assets.resolve, false);
  assert.equal(capabilities.savePolicy, 'explicit');
  assert.equal(resolveAdapterCapabilities({ capabilities: { comments: { create: true } } }).comments.create, false);
});

test('adapter capabilities expose asset resolution only when implemented', () => {
  const adapter = {
    async load() { return {}; },
    resolveAsset({ src }) { return `/asset?source=${encodeURIComponent(src)}`; },
    capabilities: { assets: { resolve: true } },
  };
  assert.equal(resolveAdapterCapabilities(adapter).assets.resolve, true);
  assert.equal(resolveAdapterCapabilities({ capabilities: { assets: { resolve: true } } }).assets.resolve, false);
});
