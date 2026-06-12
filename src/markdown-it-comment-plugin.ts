import MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { CommentConvertMode } from './plugin-settings';

const tokenType = 'ob_comment';

interface MarkdownItCommentPluginOptions {
  convertMode: CommentConvertMode;
}

const pluginOptions: MarkdownItCommentPluginOptions = {
  convertMode: CommentConvertMode.Ignore,
}

export const MarkdownItCommentPluginInstance = {
  plugin: plugin,
  updateConvertMode: (mode: CommentConvertMode) => {
    pluginOptions.convertMode = mode;
  },
}

function plugin(md: MarkdownIt): void {
  // Block rule: handles %% on its own line as the opener/closer of a multi-line comment.
  md.block.ruler.before('paragraph', `${tokenType}_block`, (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const startLineEnd = state.eMarks[startLine];
    const openingLine = state.src.slice(startPos, startLineEnd).trim();

    // Opening must be exactly %%
    if (openingLine !== '%%') return false;

    // Find the closing line that is exactly %%
    let closingLine = startLine + 1;
    while (closingLine <= endLine) {
      const lStart = state.bMarks[closingLine] + state.tShift[closingLine];
      const lEnd = state.eMarks[closingLine];
      if (state.src.slice(lStart, lEnd).trim() === '%%') break;
      closingLine++;
    }

    if (closingLine > endLine) return false; // no closing %% found
    if (silent) return true;

    const token = state.push(tokenType, '', 0);
    // Capture everything between the opening and closing %%
    const contentStart = state.eMarks[startLine] + 1;
    const contentEnd = state.bMarks[closingLine];
    token.content = state.src.slice(contentStart, contentEnd).trim();

    state.line = closingLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference'] });

  // Inline rule: handles %% comment %% on a single line / within a paragraph.
  md.inline.ruler.before('emphasis', tokenType, (state, silent) => {
    const start = state.pos;
    const max = state.posMax;
    const src = state.src;

    if (src.charCodeAt(start) !== 0x25 /* % */ || start + 4 >= max) return false;
    if (src.charCodeAt(start + 1) !== 0x25 /* % */) return false;

    // find closing %%
    let end = start + 2;
    while (end < max && (src.charCodeAt(end) !== 0x25 /* % */ || src.charCodeAt(end + 1) !== 0x25 /* % */)) {
      end++;
    }

    if (end >= max) return false;

    end += 2; // skip closing %%

    if (!silent) {
      const token = state.push(tokenType, 'comment', 0);
      token.content = src.slice(start + 2, end - 2).trim();
      state.pos = end;
    } else {
      state.pos = end;
    }
    return true;
  });

  md.renderer.rules[tokenType] = (tokens, idx) => {
    if (pluginOptions.convertMode === CommentConvertMode.HTML) {
      return `<!-- ${tokens[idx].content} -->`;
    }
    return '';
  };
}
