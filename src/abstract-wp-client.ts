import { Notice, TFile } from 'obsidian';
import WordpressPlugin from './main';
import {
  WordPressAuthParams,
  WordPressClient,
  WordPressClientResult,
  WordPressClientReturnCode,
  WordPressMediaUploadResult,
  WordPressPostParams,
  WordPressPublishResult
} from './wp-client';
import { WpPublishModal } from './wp-publish-modal';
import { PostType, PostTypeConst, Term } from './wp-api';
import { ERROR_NOTICE_TIMEOUT, WP_DEFAULT_PROFILE_NAME } from './consts';
import {
  isPromiseFulfilledResult,
  isValidUrl,
  openWithBrowser,
  patchFrontMatter,
  processFile,
  SafeAny,
  showError,
} from './utils';
import { WpProfile } from './wp-profile';
import { AppState } from './app-state';
import { ConfirmCode, openConfirmModal } from './confirm-modal';
import fileTypeChecker from 'file-type-checker';
import { MatterData, Media } from './types';
import { openPostPublishedModal } from './post-published-modal';
import { openLoginModal } from './wp-login-modal';
import { isFunction } from 'lodash-es';
import { Logger } from './logger';

export abstract class AbstractWordPressClient implements WordPressClient {

  /**
   * Client name.
   */
  name = 'AbstractWordPressClient';

  protected constructor(
    protected readonly plugin: WordpressPlugin,
    protected readonly profile: WpProfile
  ) { }

  abstract publish(
    title: string,
    content: string,
    postParams: WordPressPostParams,
    certificate: WordPressAuthParams
  ): Promise<WordPressClientResult<WordPressPublishResult>>;

  abstract getCategories(
    certificate: WordPressAuthParams
  ): Promise<Term[]>;

  abstract getPostTypes(
    certificate: WordPressAuthParams
  ): Promise<PostType[]>;

  abstract validateUser(
    certificate: WordPressAuthParams
  ): Promise<WordPressClientResult<boolean>>;

  abstract getTag(
    name: string,
    certificate: WordPressAuthParams
  ): Promise<Term>;

  abstract uploadMedia(
    media: Media,
    certificate: WordPressAuthParams
  ): Promise<WordPressClientResult<WordPressMediaUploadResult>>;

  protected needLogin(): boolean {
    return true;
  }

  private async getAuth(): Promise<WordPressAuthParams> {
    Logger.verbose('getAuth: checking credentials for profile', this.profile.name);
    let auth: WordPressAuthParams = {
      username: null,
      password: null
    };
    try {
      if (this.needLogin()) {
        // Check if there's saved username and password
        if (this.profile.username && this.profile.password) {
          Logger.verbose('getAuth: using saved credentials, validating user');
          auth = {
            username: this.profile.username,
            password: this.profile.password
          };
          const authResult = await this.validateUser(auth);
          Logger.verbose('getAuth: validateUser result', authResult.code);
          if (authResult.code !== WordPressClientReturnCode.OK) {
            throw new Error(this.plugin.i18n.t('error_invalidUser'));
          }
        } else {
          Logger.verbose('getAuth: no saved credentials, will prompt login modal');
        }
      } else {
        Logger.verbose('getAuth: login not required for this client');
      }
    } catch (error) {
      Logger.verbose('getAuth: credential check failed, opening login modal', error);
      showError(error);
      const result = await openLoginModal(this.plugin, this.profile, async (auth) => {
        const authResult = await this.validateUser(auth);
        return authResult.code === WordPressClientReturnCode.OK;
      });
      auth = result.auth;
    }
    Logger.verbose('getAuth: resolved auth username', auth.username);
    return auth;
  }

  private async checkExistingProfile(matterData: MatterData) {
    const { profileName } = matterData;
    const isProfileNameMismatch = profileName && profileName !== this.profile.name;
    if (isProfileNameMismatch) {
      const confirm = await openConfirmModal({
        message: this.plugin.i18n.t('error_profileNotMatch'),
        cancelText: this.plugin.i18n.t('profileNotMatch_useOld', {
          profileName: matterData.profileName
        }),
        confirmText: this.plugin.i18n.t('profileNotMatch_useNew', {
          profileName: this.profile.name
        })
      }, this.plugin);
      if (confirm.code !== ConfirmCode.Cancel) {
        delete matterData.postId;
        matterData.categories = this.profile.lastSelectedCategories ?? [ 1 ];
      }
    }
  }

  private async tryToPublish(params: {
    postParams: WordPressPostParams,
    auth: WordPressAuthParams,
    updateMatterData?: (matter: MatterData) => void,
  }): Promise<WordPressClientResult<WordPressPublishResult>> {
    const { postParams, auth, updateMatterData } = params;
    Logger.verbose('tryToPublish: resolving tags', postParams.tags);
    const tagTerms = await this.getTags(postParams.tags, auth);
    postParams.tags = tagTerms.map(term => term.id);
    Logger.verbose('tryToPublish: resolved tag IDs', postParams.tags);
    Logger.verbose('tryToPublish: processing post images');
    await this.updatePostImages({ auth, postParams });
    if (postParams.featuredImagePath) {
      Logger.verbose('tryToPublish: uploading featured image', postParams.featuredImagePath);
      postParams.featuredMediaId = await this.uploadFeaturedImage(postParams.featuredImagePath, auth);
      Logger.verbose('tryToPublish: featured image mediaId', postParams.featuredMediaId);
    }

    let content = postParams.content;
    if (!this.plugin.settings.uploadRawMarkdown) {
      Logger.verbose('tryToPublish: rendering markdown to HTML');
      content = AppState.markdownParser.render(postParams.content);
    } else {
      Logger.verbose('tryToPublish: uploading raw markdown (no HTML render)');
    }
    Logger.verbose('tryToPublish: calling publish', {
      title: postParams.title,
      postId: postParams.postId,
      status: postParams.status,
      postType: postParams.postType,
      categories: postParams.categories,
      tags: postParams.tags,
      contentLength: content.length,
    });
    const result = await this.publish(
      postParams.title ?? 'A post from Obsidian!',
      content,
      postParams,
      auth);
    Logger.verbose('tryToPublish: publish result', result.code);
    if (result.code === WordPressClientReturnCode.Error) {
      Logger.verbose('tryToPublish: publish failed', result.error);
      throw new Error(this.plugin.i18n.t('error_publishFailed', {
        code: result.error.code as string,
        message: result.error.message
      }));
    } else {
      Logger.verbose('tryToPublish: publish succeeded, postId', result.data?.postId);
      new Notice(this.plugin.i18n.t('message_publishSuccessfully'));
      // post id will be returned if creating, true if editing
      const postId = result.data.postId;
      if (postId) {
        // const modified = matter.stringify(postParams.content, matterData, matterOptions);
        // this.updateFrontMatter(modified);
        const file = this.plugin.app.workspace.getActiveFile();
        if (file) {
          // Collect all updates first so we can use raw-text patching that
          // preserves YAML comments in the frontmatter.
          const updates: Record<string, unknown> = {
            profileName: this.profile.name,
            postId: String(postId),
            postType: postParams.postType,
          };
          if (postParams.postType === PostTypeConst.Post) {
            updates.categories = postParams.categories.map(String);
            updates.tags = postParams.tags.length > 0 ? postParams.tags : undefined;
          }
          if (postParams.excerpt !== undefined) updates.excerpt = postParams.excerpt || undefined;
          if (postParams.slug !== undefined) updates.slug = postParams.slug || undefined;
          if (postParams.sticky !== undefined) updates.sticky = postParams.sticky;
          if (postParams.featuredImagePath) updates.featuredImage = postParams.featuredImagePath;
          if (isFunction(updateMatterData)) {
            updateMatterData(new Proxy({} as MatterData, {
              set(_: MatterData, prop: string, val: unknown) { updates[prop] = val; return true; },
              deleteProperty(_: MatterData, prop: string) { updates[prop] = undefined; return true; }
            }));
          }
          await patchFrontMatter(file, this.plugin.app, updates);
        }

        if (this.plugin.settings.rememberLastSelectedCategories) {
          this.profile.lastSelectedCategories = (result.data as SafeAny).categories;
          await this.plugin.saveSettings();
        }

        if (this.plugin.settings.showWordPressEditConfirm) {
          openPostPublishedModal(this.plugin)
            .then(() => {
              openWithBrowser(`${this.profile.endpoint}/wp-admin/post.php`, {
                action: 'edit',
                post: postId
              });
            });
        }
      }
    }
    return result;
  }

  private async updatePostImages(params: {
    postParams: WordPressPostParams,
    auth: WordPressAuthParams,
  }): Promise<void> {
    const { postParams, auth } = params;

    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (activeFile === null) {
      throw new Error(this.plugin.i18n.t('error_noActiveFile'));
    }
    const { activeEditor } = this.plugin.app.workspace;
    if (activeEditor && activeEditor.editor) {
      // process images
      const images = getImages(postParams.content);
      Logger.verbose('updatePostImages: found images', images.length);
      for (const img of images) {
        if (!img.srcIsUrl) {
          Logger.verbose('updatePostImages: uploading local image', img.src);
          img.src = decodeURI(img.src);
          const fileName = img.src.split("/").pop();

          if ( fileName === undefined ) {
            continue;
          }

          const normPath = this.plugin.app.metadataCache.getFirstLinkpathDest(img.src, fileName);

          const imgFile = normPath;

          if (imgFile instanceof TFile) {
            const content = await this.plugin.app.vault.readBinary(imgFile);
            const fileType = fileTypeChecker.detectFile(content);
            const result = await this.uploadMediaWithCache({
              mimeType: fileType?.mimeType ?? 'application/octet-stream',
              fileName: imgFile.name,
              content: content
            }, auth);
            if (result.code === WordPressClientReturnCode.OK) {
              Logger.verbose('updatePostImages: uploaded image, url', result.data.url);
              if(img.width && img.height){
                  postParams.content = postParams.content.replace(img.original, `![[${result.data.url}|${img.width}x${img.height}]]`);
              }else if (img.width){
                  postParams.content = postParams.content.replace(img.original, `![[${result.data.url}|${img.width}]]`);
              }else{
                  postParams.content = postParams.content.replace(img.original, `![[${result.data.url}]]`);
              }
            } else {
              Logger.verbose('updatePostImages: image upload failed', result.error);
              if (result.error.code === WordPressClientReturnCode.ServerInternalError) {
                new Notice(result.error.message, ERROR_NOTICE_TIMEOUT);
              } else {
                new Notice(this.plugin.i18n.t('error_mediaUploadFailed', {
                  name: imgFile.name,
                }), ERROR_NOTICE_TIMEOUT);
              }
            }
          }
        } else {
          Logger.verbose('updatePostImages: skipping remote image', img.src);
        }
      }
      if (this.plugin.settings.replaceMediaLinks) {
        const raw = await this.plugin.app.vault.read(activeFile);
        const frontmatterMatch = raw.match(/^---[\s\S]+?---\s*\n/);
        const preamble = frontmatterMatch ? frontmatterMatch[0] : '';
        activeEditor.editor.setValue(preamble + postParams.content);
      }
    }
  }

  private async hashContent(content: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async uploadMediaWithCache(
    media: Media,
    auth: WordPressAuthParams
  ): Promise<WordPressClientResult<WordPressMediaUploadResult>> {
    const hash = await this.hashContent(media.content);
    const cached = this.profile.mediaCache?.[hash];
    if (cached) {
      Logger.verbose('uploadMediaWithCache: cache hit', hash);
      return { code: WordPressClientReturnCode.OK, data: cached };
    }
    const result = await this.uploadMedia(media, auth);
    if (result.code === WordPressClientReturnCode.OK) {
      if (!this.profile.mediaCache) this.profile.mediaCache = {};
      this.profile.mediaCache[hash] = result.data;
      await this.plugin.saveSettings();
    }
    return result;
  }

  private async uploadFeaturedImage(imagePath: string, auth: WordPressAuthParams): Promise<number | undefined> {
    const sourcePath = this.plugin.app.workspace.getActiveFile()?.path ?? '';
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(imagePath, sourcePath);
    if (!(file instanceof TFile)) {
      Logger.verbose('uploadFeaturedImage: file not found', imagePath);
      return undefined;
    }
    const content = await this.plugin.app.vault.readBinary(file);
    const fileType = fileTypeChecker.detectFile(content);
    const result = await this.uploadMediaWithCache({
      mimeType: fileType?.mimeType ?? 'application/octet-stream',
      fileName: file.name,
      content
    }, auth);
    if (result.code === WordPressClientReturnCode.OK && result.data.mediaId) {
      return Number(result.data.mediaId);
    }
    Logger.verbose('uploadFeaturedImage: upload failed or no mediaId returned');
    return undefined;
  }

  async publishPost(defaultPostParams?: WordPressPostParams): Promise<WordPressClientResult<WordPressPublishResult>> {
    Logger.log('publishPost: starting', { client: this.name, profile: this.profile.name });
    try {
      if (!this.profile.endpoint || this.profile.endpoint.length === 0) {
        throw new Error(this.plugin.i18n.t('error_noEndpoint'));
      }
      // const { activeEditor } = this.plugin.app.workspace;
      const file = this.plugin.app.workspace.getActiveFile()
      if (file === null) {
        throw new Error(this.plugin.i18n.t('error_noActiveFile'));
      }
      Logger.verbose('publishPost: active file', file.path);

      // get auth info
      const auth = await this.getAuth();

      // read note title, content and matter data
      const title = file.basename;
      const { content, matter: matterData } = await processFile(file, this.plugin.app);
      Logger.verbose('publishPost: note title', title, 'content length', content.length, 'matter keys', Object.keys(matterData));

      // check if profile selected is matched to the one in note property,
      // if not, ask whether to update or not
      await this.checkExistingProfile(matterData);

      // now we're preparing the publishing data
      let postParams: WordPressPostParams;
      let result: WordPressClientResult<WordPressPublishResult> | undefined;
      if (defaultPostParams) {
        postParams = this.readFromFrontMatter(title, matterData, defaultPostParams);
        postParams.content = content;
        result = await this.tryToPublish({
          auth,
          postParams
        });
      } else {
        const categories = await this.getCategories(auth);
        const rawCats = matterData.categories as (number | string)[] | undefined;
        const selectedCategories = rawCats?.map(Number)
          ?? this.profile.lastSelectedCategories
          ?? [ 1 ];
        const postTypes = await this.getPostTypes(auth);
        if (postTypes.length === 0) {
          postTypes.push(PostTypeConst.Post);
        }
        const selectedPostType = matterData.postType ?? PostTypeConst.Post;
        result = await new Promise(resolve => {
          const publishModal = new WpPublishModal(
            this.plugin,
            { items: categories, selected: selectedCategories },
            { items: postTypes, selected: selectedPostType },
            async (postParams: WordPressPostParams, updateMatterData: (matter: MatterData) => void) => {
              postParams = this.readFromFrontMatter(title, matterData, postParams);
              postParams.content = content;
              try {
                const r = await this.tryToPublish({
                  auth,
                  postParams,
                  updateMatterData
                });
                if (r.code === WordPressClientReturnCode.OK) {
                  publishModal.close();
                  resolve(r);
                }
              } catch (error) {
                if (error instanceof Error) {
                  return showError(error);
                } else {
                  throw error;
                }
              }
            },
            matterData);
          publishModal.open();
        });
      }
      if (result) {
        return result;
      } else {
        throw new Error(this.plugin.i18n.t("message_publishFailed"));
      }
    } catch (error) {
      if (error instanceof Error) {
        return showError(error);
      } else {
        throw error;
      }
    }
  }

  private async getTags(tags: string[], certificate: WordPressAuthParams): Promise<Term[]> {
    const results = await Promise.allSettled(tags.map(name => this.getTag(name, certificate)));
    const terms: Term[] = [];
    results
      .forEach(result => {
        if (isPromiseFulfilledResult<Term>(result)) {
          terms.push(result.value);
        }
      });
    return terms;
  }

  private readFromFrontMatter(
    noteTitle: string,
    matterData: MatterData,
    params: WordPressPostParams
  ): WordPressPostParams {
    const postParams = { ...params };
    postParams.title = noteTitle;
    if (matterData.title) {
      postParams.title = matterData.title;
    }
    if (matterData.postId) {
      postParams.postId = String(matterData.postId);
    }
    postParams.profileName = matterData.profileName ?? WP_DEFAULT_PROFILE_NAME;
    if (matterData.postType) {
      postParams.postType = matterData.postType;
    } else {
      // if there is no post type in matter-data, assign it as 'post'
      postParams.postType = PostTypeConst.Post;
    }
    if (postParams.postType === PostTypeConst.Post) {
      // only 'post' supports categories and tags
      if (!postParams.tags.length && matterData.tags) {
        postParams.tags = (matterData.tags as (number | string)[]).map(String);
      }
    }
    if (postParams.excerpt === undefined && matterData.excerpt) {
      postParams.excerpt = String(matterData.excerpt);
    }
    if (postParams.slug === undefined && matterData.slug) {
      postParams.slug = String(matterData.slug);
    }
    if (postParams.sticky === undefined && matterData.sticky !== undefined) {
      postParams.sticky = Boolean(matterData.sticky);
    }
    if (postParams.featuredImagePath === undefined && matterData.featuredImage) {
      postParams.featuredImagePath = String(matterData.featuredImage);
    }
    return postParams;
  }

}

interface Image {
  original: string;
  src: string;
  altText?: string;
  width?: string;
  height?: string;
  srcIsUrl: boolean;
  startIndex: number;
  endIndex: number;
  file?: TFile;
  content?: ArrayBuffer;
}

function getImages(content: string): Image[] {
  const paths: Image[] = [];

  // for ![Alt Text](image-url)
  let regex = /(!\[(.*?)(?:\|(\d+)(?:x(\d+))?)?]\((.*?)\))/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    paths.push({
      src: match[5],
      altText: match[2],
      width: match[3],
      height: match[4],
      original: match[1],
      startIndex: match.index,
      endIndex: match.index + match.length,
      srcIsUrl: isValidUrl(match[5]),
    });
  }

  // for ![[image-name]]
  regex = /(!\[\[(.*?)(?:\|(\d+)(?:x(\d+))?)?]])/g;
  while ((match = regex.exec(content)) !== null) {
    paths.push({
      src: match[2],
      original: match[1],
      width: match[3],
      height: match[4],
      startIndex: match.index,
      endIndex: match.index + match.length,
      srcIsUrl: isValidUrl(match[2]),
    });
  }

  return paths;
}
