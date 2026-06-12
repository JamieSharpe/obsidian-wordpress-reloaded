import { App, Notice, Setting, TFile, parseYaml } from 'obsidian';
import { WpProfile } from './wp-profile';
import { WordpressPluginSettings } from './plugin-settings';
import { MarkdownItMathJax3PluginInstance } from './markdown-it-mathjax3-plugin';
import { WordPressClientResult, WordPressClientReturnCode, WordPressPostParams } from './wp-client';
import { getWordPressClient } from './wp-clients';
import WordpressPlugin from './main';
import { isString } from 'lodash-es';
import { ERROR_NOTICE_TIMEOUT } from './consts';
import { Logger } from './logger';
import { format } from 'date-fns';
import { MatterData } from './types';
import { MarkdownItCommentPluginInstance } from './markdown-it-comment-plugin';

export type SafeAny = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export function openWithBrowser(url: string, queryParams: Record<string, undefined|number|string> = {}): void {
  window.open(`${url}?${generateQueryString(queryParams)}`);
}

export function generateQueryString(params: Record<string, undefined|number|string>): string {
  return new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).filter( ([k, v]) => v!==undefined)
    ) as Record<string, string>
  ).toString();
}

export function isPromiseFulfilledResult<T>(obj: SafeAny): obj is PromiseFulfilledResult<T> {
  return !!obj && obj.status === 'fulfilled' && obj.value;
}

export function setupMarkdownParser(settings: WordpressPluginSettings): void {
  MarkdownItMathJax3PluginInstance.updateOutputType(settings.mathJaxOutputType);
  MarkdownItCommentPluginInstance.updateConvertMode(settings.commentConvertMode);
}


export function rendererProfile(profile: WpProfile, container: HTMLElement): Setting {
  let name = profile.name;
  if (profile.isDefault) {
    name += ' ✔️';
  }
  let desc = profile.endpoint;
  if (profile.wpComOAuth2Token) {
    desc += ` / 🆔 / 🔒`;
  } else {
    if (profile.saveUsername) {
      desc += ` / 🆔 ${profile.username}`;
    }
    if (profile.savePassword) {
      desc += ' / 🔒 ******';
    }
  }
  return new Setting(container)
    .setName(name)
    .setDesc(desc);
}

export function isValidUrl(url: string): boolean {
  try {
    return Boolean(new URL(url));
  } catch(e) {
    return false;
  }
}

export function doClientPublish(plugin: WordpressPlugin, profile: WpProfile, defaultPostParams?: WordPressPostParams): void;
export function doClientPublish(plugin: WordpressPlugin, profileName: string, defaultPostParams?: WordPressPostParams): void;
export function doClientPublish(
  plugin: WordpressPlugin,
  profileOrName: WpProfile | string,
  defaultPostParams?: WordPressPostParams
): void {
  const profileName = isString(profileOrName) ? profileOrName : profileOrName.name;
  Logger.log('doClientPublish: starting for profile', profileName);
  Logger.verbose('doClientPublish: defaultPostParams', defaultPostParams);
  let profile: WpProfile | undefined;
  if (isString(profileOrName)) {
    profile = plugin.settings.profiles.find(it => it.name === profileOrName);
  } else {
    profile = profileOrName;
  }
  if (profile) {
    Logger.verbose('doClientPublish: resolved profile', profile.name, 'apiType', profile.apiType);
    const client = getWordPressClient(plugin, profile);
    if (client) {
      Logger.verbose('doClientPublish: client created, publishing');
      client.publishPost(defaultPostParams).catch(err => {
        Logger.verbose('doClientPublish: publish error', err);
        showError(err);
      });
    } else {
      Logger.verbose('doClientPublish: no client available for profile');
    }
  } else {
    const noSuchProfileMessage = plugin.i18n.t('error_noSuchProfile', {
      profileName: String(profileOrName)
    });
    showError(noSuchProfileMessage);
    throw new Error(noSuchProfileMessage);
  }
}

export function getBoundary(): string {
  return `----obsidianBoundary${format(new Date(), 'yyyyMMddHHmmss')}`;
}

export function showError<T>(error: unknown): WordPressClientResult<T> {
  let errorMessage: string;
  if (isString(error)) {
    errorMessage = error;
  } else if (error instanceof Error) {
    errorMessage = error.message;
  } else {
    errorMessage = (error as SafeAny).toString();
  }
  new Notice(errorMessage, ERROR_NOTICE_TIMEOUT);
  return {
    code: WordPressClientReturnCode.Error as const,
    error: {
      code: WordPressClientReturnCode.Error,
      message: errorMessage,
    }
  };
}

function fmEscapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setFmKey(body: string, key: string, value: unknown): string {
  const ek = fmEscapeRe(key);
  if (Array.isArray(value)) {
    const items = (value as unknown[]).map(v => `  - ${v}`).join('\n');
    const newBlock = `${key}:\n${items}`;
    // Block-style: key:\n  - item\n  - item
    const blockRe = new RegExp(`^${ek}:[ \\t]*(?:\\r?\\n[ \\t]+-[^\\r\\n]*)+`, 'm');
    if (blockRe.test(body)) return body.replace(blockRe, newBlock);
    // Inline-style: key: [item, item]
    const inlineRe = new RegExp(`^${ek}:[ \\t]*\\[.*?\\][ \\t]*$`, 'm');
    if (inlineRe.test(body)) return body.replace(inlineRe, newBlock);
    return body.trimEnd() + '\n' + newBlock;
  } else {
    const yaml = `${key}: ${value == null ? '' : String(value)}`;
    const scalarRe = new RegExp(`^${ek}:[ \\t]*[^\\r\\n]*$`, 'm');
    if (scalarRe.test(body)) return body.replace(scalarRe, yaml);
    return body.trimEnd() + '\n' + yaml;
  }
}

function removeFmKey(body: string, key: string): string {
  const ek = fmEscapeRe(key);
  const blockRe = new RegExp(`^${ek}:[ \\t]*(?:\\r?\\n[ \\t]+-[^\\r\\n]*)+`, 'm');
  const withoutBlock = body.replace(blockRe, '');
  if (withoutBlock !== body) return withoutBlock;
  return body.replace(new RegExp(`^${ek}:[ \\t]*[^\\r\\n]*(?:\\r?\\n|$)`, 'm'), '');
}

/**
 * Updates frontmatter properties using raw text replacement so that YAML
 * comments and unrelated properties are preserved. Pass `undefined` as value
 * to delete a key. Falls back to processFrontMatter when no frontmatter exists.
 */
export async function patchFrontMatter(
  file: TFile,
  app: App,
  updates: Record<string, unknown>
): Promise<void> {
  const raw = await app.vault.read(file);
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    await app.fileManager.processFrontMatter(file, fm => {
      for (const [k, v] of Object.entries(updates)) {
        if (v === undefined) delete fm[k];
        else fm[k] = v;
      }
    });
    return;
  }
  let body = fmMatch[1];
  const tail = raw.slice(fmMatch[0].length);
  for (const [key, value] of Object.entries(updates)) {
    body = value === undefined ? removeFmKey(body, key) : setFmKey(body, key, value);
  }
  await app.vault.modify(file, `---\n${body}\n---${tail}`);
}

export async function processFile(file: TFile, app: App): Promise<{ content: string, matter: MatterData }> {
  const raw = await app.vault.read(file);
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const matter: MatterData = app.metadataCache.getFileCache(file)?.frontmatter
    ?? (fmMatch ? (parseYaml(fmMatch[1]) ?? {}) : {});
  return {
    content: raw.replace(/^---[\s\S]+?---/, '').trim(),
    matter
  };
}
