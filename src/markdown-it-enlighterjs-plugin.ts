import MarkdownIt from 'markdown-it';

interface EnlighterJSPluginOptions {
  enabled: boolean;
}

const pluginOptions: EnlighterJSPluginOptions = {
  enabled: false,
};

export const MarkdownItEnlighterJSPluginInstance = {
  plugin,
  setEnabled: (enabled: boolean) => {
    pluginOptions.enabled = enabled;
  },
};

/**
 * Parses a fenced code block info string into a language and a map of
 * EnlighterJS data attributes. Supports both quoted and unquoted values.
 *
 * Example:
 *   ```javascript linenumbers=true offset=5 highlight=1,3-5 title="My Code" group=demo
 */
function parseInfoString(info: string): { lang: string; attrs: Record<string, string> } {
  const trimmed = info.trim();
  if (!trimmed) return { lang: '', attrs: {} };

  const langMatch = trimmed.match(/^(\S+)/);
  const lang = langMatch ? langMatch[1] : '';
  const rest = trimmed.slice(lang.length);

  const attrs: Record<string, string> = {};
  const attrRegex = /([\w-]+)=(?:"([^"]*?)"|'([^']*?)'|(\S+))/g;
  let match;
  while ((match = attrRegex.exec(rest)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }

  return { lang, attrs };
}

const ATTR_MAP: Record<string, string> = {
  linenumbers:  'data-enlighter-linenumbers',
  lineoffset:   'data-enlighter-lineoffset',
  offset:       'data-enlighter-lineoffset',
  highlight:    'data-enlighter-highlight',
  title:        'data-enlighter-title',
  group:        'data-enlighter-group',
  theme:        'data-enlighter-theme',
  indent:       'data-enlighter-indent',
};

function plugin(md: MarkdownIt): void {
  const prevFence = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    if (!pluginOptions.enabled) {
      if (prevFence) return prevFence(tokens, idx, options, env, self);
      // Reproduce markdown-it's default fence output
      const token = tokens[idx];
      const info   = token.info ? token.info.trim() : '';
      const lang   = info ? info.split(/\s+/)[0] : '';
      const cls    = lang ? ` class="language-${md.utils.escapeHtml(lang)}"` : '';
      return `<pre><code${cls}>${md.utils.escapeHtml(token.content)}</code></pre>\n`;
    }

    const token = tokens[idx];
    const { lang, attrs } = parseInfoString(token.info ?? '');

    const parts: string[] = ['class="EnlighterJSRAW"'];

    if (lang) {
      parts.push(`data-enlighter-language="${md.utils.escapeHtml(lang)}"`);
    }

    for (const [key, dataAttr] of Object.entries(ATTR_MAP)) {
      if (attrs[key] !== undefined) {
        parts.push(`${dataAttr}="${md.utils.escapeHtml(attrs[key])}"`);
      }
    }

    return `<pre ${parts.join(' ')}>${md.utils.escapeHtml(token.content)}</pre>\n`;
  };
}
