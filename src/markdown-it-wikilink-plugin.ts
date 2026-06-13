import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const tokenType = 'ob_wikilink';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getHeadingText(inlineToken: Token): string {
  if (!inlineToken.children) return inlineToken.content;
  return inlineToken.children
    .filter(t => t.type === 'text' || t.type === 'code_inline' || t.type === 'softbreak')
    .map(t => t.content)
    .join('');
}

export function markdownItWikilinkPlugin(md: MarkdownIt): void {
  // Convert [[#Heading]] and [[#Heading|Display Text]] to anchor links
  md.inline.ruler.after('image', tokenType, (state, silent) => {
    const regex = /^\[\[#([^|\]\n]+)(?:\|([^\]\n]+))?\]\]/;
    const match = state.src.slice(state.pos).match(regex);
    if (!match) return false;
    if (silent) return true;

    const heading = match[1].trim();
    const displayText = match[2]?.trim() ?? heading;

    const token = state.push(tokenType, 'a', 0);
    token.attrSet('href', `#${slugify(heading)}`);
    token.content = displayText;

    state.pos += match[0].length;
    return true;
  });

  md.renderer.rules[tokenType] = (tokens: Token[], idx: number) => {
    const token = tokens[idx];
    const href = token.attrGet('href') ?? '#';
    const text = md.utils.escapeHtml(token.content);
    return `<a href="${href}">${text}</a>`;
  };

  // Normalize fragment-only hrefs in regular markdown links to match slugified heading ids.
  // e.g. [TLDR](#TLDR) → <a href="#tldr"> so it resolves against id="tldr".
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIdx = token.attrIndex('href');
    if (hrefIdx >= 0) {
      const href = token.attrs![hrefIdx][1];
      if (href.startsWith('#')) {
        token.attrs![hrefIdx][1] = `#${slugify(href.slice(1))}`;
      }
    }
    return self.renderToken(tokens, idx, options);
  };

  // Add id attributes to heading elements so internal anchor links resolve
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const inlineToken = tokens[idx + 1];
    if (inlineToken) {
      const headingText = getHeadingText(inlineToken);
      const id = slugify(headingText);
      if (id) {
        token.attrSet('id', id);
      }
    }
    return self.renderToken(tokens, idx, options);
  };
}
