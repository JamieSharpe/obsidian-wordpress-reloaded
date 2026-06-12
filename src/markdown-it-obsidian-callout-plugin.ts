import MarkdownIt from 'markdown-it';

const CALLOUT_RE = /^\[!([^\]]+)\][ \t]*(.*?)(?:\n([\s\S]*))?$/;

export function markdownItObsidianCalloutPlugin(md: MarkdownIt): void {
  md.core.ruler.before('inline', 'obsidian_callout', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;

      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_close') break;
        if (tokens[j].type !== 'inline') continue;

        const match = tokens[j].content.match(CALLOUT_RE);
        if (!match) break;

        // match[2] = optional title, match[3] = remaining content
        const title = match[2].trim();
        const rest = (match[3] ?? '').trim();
        if (title && rest) {
          tokens[j].content = `**${title}**\n${rest}`;
        } else if (title) {
          tokens[j].content = `**${title}**`;
        } else {
          tokens[j].content = rest;
        }
        break;
      }
    }
  });
}
