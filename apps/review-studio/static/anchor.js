// anchor.js — surgical extract of the comment-anchor logic from kanban ai.js
// (lines ~124-262 of modules/ai.js). Logic kept VERBATIM; only the surrounding
// ctx wiring is doc-mode instead of card-mode. This is the reusable gem that
// makes prefix/suffix + block-index anchoring survive upstream edits.
export function setupAnchor(ctx) {
  const { uiState } = ctx;
  const toast = ctx.ui.toast;

  function normalizedQuoteText(value) {
    return String(value || '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ').trim();
  }

  function bodyQuoteBlocks() {
    const root = ctx.el.detailMdContent;
    return root
      ? Array.from(root.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th'))
        .filter((block) => !(block.closest && block.closest('.comment-quote-block')))
      : [];
  }

  function chooseSourceQuoteIndex(sourceQuote, bodyText, currentRev) {
    const quote = String(sourceQuote && sourceQuote.quote_text || '');
    const body = String(bodyText || '');
    if (!quote) return -1;
    const matches = [];
    let cursor = 0;
    while (cursor <= body.length - quote.length) {
      const found = body.indexOf(quote, cursor);
      if (found < 0) break;
      matches.push(found);
      cursor = found + Math.max(quote.length, 1);
    }
    if (!matches.length) return -1;
    if (matches.length === 1) return matches[0];
    const locator = sourceQuote.source_locator || {};
    const recorded = Number(locator.text_index);
    if (locator.body_rev && currentRev && locator.body_rev === currentRev && matches.includes(recorded)) return recorded;
    const context = sourceQuote.context || {};
    const prefix = String(locator.prefix || context.prefix || '').slice(-160);
    const suffix = String(locator.suffix || context.suffix || '').slice(0, 160);
    const scored = matches.map((index) => {
      let score = 0;
      if (prefix && body.slice(Math.max(0, index - prefix.length), index) === prefix) score += 2;
      if (suffix && body.slice(index + quote.length, index + quote.length + suffix.length) === suffix) score += 2;
      return { index, score };
    }).sort((a, b) => b.score - a.score);
    if (!scored[0].score || (scored[1] && scored[1].score === scored[0].score)) return -1;
    return scored[0].index;
  }

  function resolveBodyQuoteTarget(sourceQuote) {
    if (!sourceQuote || !ctx.el.detailMdContent) return null;
    const locator = sourceQuote.source_locator || {};
    if (locator.task_path && locator.task_path !== uiState.detail.currentTaskPath) return null;
    const needle = normalizedQuoteText(sourceQuote.quote_text);
    if (!needle) return null;
    const blocks = bodyQuoteBlocks();
    const rawIndex = chooseSourceQuoteIndex(
      sourceQuote,
      uiState.detail.currentTaskBody || '',
      uiState.detail.currentTaskRev || '',
    );
    // AI review writeback is anchored on exact source offsets. The server does
    // not run the browser's Markdown lexer, so it cannot safely invent a DOM
    // block index. Each rendered top-level block exposes its source range;
    // resolve the exact source offset back into that block before using the
    // older block_index / text-search fallbacks.
    const indexed = Number(locator.block_index);
    if (rawIndex >= 0 && !(Number.isInteger(indexed) && indexed >= 0)) {
      const wraps = Array.from(ctx.el.detailMdContent.querySelectorAll('.doc-block[data-source-start][data-source-end]'));
      const wrap = wraps.find((node) => rawIndex >= Number(node.dataset.sourceStart)
        && rawIndex < Number(node.dataset.sourceEnd));
      if (wrap) {
        const local = Array.from(wrap.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th'))
          .filter((block) => {
            const text = normalizedQuoteText(block.textContent);
            return text.includes(needle) || (needle.length > 32 && text.includes(needle.slice(0, 32)));
          });
        if (local.length === 1) return local[0];
      }
    }
    if (Number.isInteger(indexed) && indexed >= 0 && blocks[indexed]) {
      const text = normalizedQuoteText(blocks[indexed].textContent);
      if (text.includes(needle) || (needle.length > 32 && text.includes(needle.slice(0, 32)))) return blocks[indexed];
    }
    const candidates = blocks.filter((block) => {
      const text = normalizedQuoteText(block.textContent);
      return text.includes(needle) || (needle.length > 32 && text.includes(needle.slice(0, 32)));
    });
    const occurrence = Number(locator.occurrence_index);
    if (Number.isInteger(occurrence) && occurrence >= 0 && candidates[occurrence]) return candidates[occurrence];
    if (rawIndex < 0 && Number(locator.text_index) >= 0 && candidates.length !== 1) return null;
    return candidates.length === 1 ? candidates[0] : null;
  }

  function jumpToBodyQuote(sourceQuote) {
    const target = resolveBodyQuoteTarget(sourceQuote);
    if (!target) {
      if (toast) toast('正文原位置已变化，保留引用快照', true);
      return false;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('body-quote-highlight');
    setTimeout(() => target.classList.remove('body-quote-highlight'), 2200);
    return true;
  }

  function sourceQuoteFromSelection(selection, range) {
    const quoteText = String(selection || '').trim();
    const body = String(uiState.detail.currentTaskBody || '');
    let textIndex = body.indexOf(quoteText);
    if (textIndex < 0) {
      const compact = quoteText.replace(/\s+/g, ' ');
      textIndex = body.replace(/\s+/g, ' ').indexOf(compact);
    }
    let section = '';
    if (textIndex >= 0) {
      const headings = Array.from(body.slice(0, textIndex).matchAll(/^#{1,6}\s+(.+)$/gm));
      if (headings.length) section = String(headings[headings.length - 1][1] || '').trim();
    }
    const block = range && range.commonAncestorContainer
      ? (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)
      : null;
    const closest = block && block.closest ? block.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, pre') : null;
    const blocks = bodyQuoteBlocks();
    const blockIndex = closest ? blocks.indexOf(closest) : -1;
    const prefix = textIndex >= 0 ? body.slice(Math.max(0, textIndex - 160), textIndex) : '';
    const suffix = textIndex >= 0 ? body.slice(textIndex + quoteText.length, textIndex + quoteText.length + 160) : '';
    return {
      quote_text: quoteText,
      section,
      context: { prefix, suffix },
      source_locator: {
        task_path: uiState.detail.currentTaskPath || '',
        body_rev: uiState.detail.currentTaskRev || '',
        text_index: textIndex,
        prefix,
        suffix,
        block_index: blockIndex,
      },
    };
  }

  ctx.anchor = {
    normalizedQuoteText,
    bodyQuoteBlocks,
    chooseSourceQuoteIndex,
    resolveBodyQuoteTarget,
    jumpToBodyQuote,
    sourceQuoteFromSelection,
  };
  // markdown.js reaches for these on ctx.ai during comment-quote rendering.
  ctx.ai = Object.assign(ctx.ai || {}, { resolveBodyQuoteTarget, jumpToBodyQuote });
  return ctx.anchor;
}
