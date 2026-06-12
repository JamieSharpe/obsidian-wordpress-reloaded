import { Events } from 'obsidian';
import MarkdownIt from 'markdown-it';
import { MarkdownItImagePluginInstance } from './markdown-it-image-plugin';
import { MarkdownItCommentPluginInstance } from './markdown-it-comment-plugin';
import { MarkdownItMathJax3PluginInstance } from './markdown-it-mathjax3-plugin';
import { MarkdownItEnlighterJSPluginInstance } from './markdown-it-enlighterjs-plugin';
import { markdownItObsidianCalloutPlugin } from './markdown-it-obsidian-callout-plugin';

class AppStore {

  markdownParser = new MarkdownIt();

  events = new Events();

  codeVerifier: string | undefined;

}

export const AppState = new AppStore();

AppState.markdownParser
  .use(MarkdownItCommentPluginInstance.plugin)
  .use(MarkdownItMathJax3PluginInstance.plugin)
  .use(MarkdownItImagePluginInstance.plugin)
  .use(MarkdownItEnlighterJSPluginInstance.plugin)
  .use(markdownItObsidianCalloutPlugin);
