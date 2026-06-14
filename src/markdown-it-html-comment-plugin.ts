import MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';

const tokenType = 'html_comment_strip';

export function markdownItHtmlCommentPlugin(md: MarkdownIt): void {
  // Block rule: strip <!-- ... --> starting at line beginning (including multiline)
  md.block.ruler.before('paragraph', tokenType, (state: StateBlock, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const src = state.src;

    if (src.slice(startPos, startPos + 4) !== '<!--') return false;

    const closePos = src.indexOf('-->', startPos + 4);
    if (closePos === -1) return false;

    if (silent) return true;

    let closingLine = startLine;
    while (closingLine <= endLine && state.eMarks[closingLine] < closePos) {
      closingLine++;
    }

    state.push(tokenType, '', 0);
    state.line = closingLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference'] });

  // Inline rule: strip <!-- ... --> within paragraph content (including multiline)
  md.inline.ruler.after('image', tokenType, (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 4) !== '<!--') return false;

    const closePos = state.src.indexOf('-->', state.pos + 4);
    if (closePos === -1) return false;

    if (silent) return true;

    state.push(tokenType, '', 0);
    state.pos = closePos + 3;
    return true;
  });

  md.renderer.rules[tokenType] = () => '';
}
