# arXiv 1706.03762v7 conversion loss report

- Converter: `scripts/convert_attention_arxiv.py` 0.1.0
- Runtime: Python 3.13.12
- Scope: one-paper spike for Attention Is All You Need, not a generic TeX importer.
- Input chain: official arXiv abs HTML, e-print TeX source, official PDF.

## Element Status

- Sections: preserved as Markdown headings; count=23.
- Equations: transformed to Markdown display math with TeX bodies retained; count=3.
- Tables: transformed from LaTeX tabular to Markdown pipe tables when parseable; count=4.
- Figures: source package assets copied and referenced by relative paths; count=5, assets=8.
- Footnotes: detected and listed in manifest; count=5.
- References: bibliography keys preserved; count=40.

## Known Losses And Downgrades

- TeX macro expansion is partial; unknown macros are preserved or simplified and require manual check.
- LaTeX labels/cross-references are not resolved to final section, table, equation, or figure numbers.
- Table typography from `booktabs`, `multirow`, `multicolumn`, spacing, and alignment is downgraded to Markdown table text.
- Figure layout options, subfigure grouping, page placement, and original PDF pagination are not preserved.
- PDF figure assets from the source package are copied but not rasterized because no PDF image conversion tool is available in this environment.
- Bibliography is flattened to Markdown list entries; citation links are not resolved bidirectionally.
- Author affiliation layout and title footnote markers are simplified.

## Redaction

This committed report excludes manuscript body text and long captions. Full source locators and samples are in the private data manifest under `apps/review-studio/data/`.
