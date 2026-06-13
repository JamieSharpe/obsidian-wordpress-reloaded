import { Plugin } from 'obsidian';
import { WordpressSettingTab } from './settings';
import { addIcons } from './icons';
import { WordPressPostParams } from './wp-client';
import { I18n } from './i18n';
import { EventType, WP_OAUTH2_REDIRECT_URI, WP_OAUTH2_URL_ACTION } from './consts';
import { OAuth2Client } from './oauth2-client';
import { CommentStatus, PostStatus, PostTypeConst } from './wp-api';
import { openProfileChooserModal } from './wp-profile-chooser-modal';
import { AppState } from './app-state';
import { DEFAULT_SETTINGS, SettingsVersion, upgradeSettings, WordpressPluginSettings } from './plugin-settings';
import { PassCrypto } from './pass-crypto';
import { doClientPublish, processFile, setupMarkdownParser, showError } from './utils';
import { cloneDeep } from 'lodash-es';
import { Logger } from './logger';

export default class WordpressPlugin extends Plugin {

  override settings!: WordpressPluginSettings;

  #i18n: I18n | undefined;
  get i18n() {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.#i18n!;
  }

  private ribbonWpIcon: HTMLElement | null = null;

  async onload() {
    Logger.log('loading obsidian-wordpress-reloaded plugin');
    Logger.verbose('onload: NODE_ENV', process.env.NODE_ENV);

    await this.loadSettings();
    // lang should be load early, but after settings
    this.#i18n = new I18n(this.settings.lang);

    setupMarkdownParser(this.settings);

    addIcons();

    this.registerProtocolHandler();
    this.updateRibbonIcon();

    this.addCommand({
      id: 'defaultPublish',
      name: this.#i18n.t('command_publishWithDefault'),
      editorCallback: () => {
        const defaultProfile = this.settings.profiles.find(it => it.isDefault);
        if (defaultProfile) {
          const params: WordPressPostParams = {
            status: this.settings.defaultPostStatus ?? PostStatus.Draft,
            commentStatus: this.settings.defaultCommentStatus ?? CommentStatus.Open,
            categories: defaultProfile.lastSelectedCategories ?? [ 1 ],
            postType: PostTypeConst.Post,
            tags: [],
            title: '',
            content: ''
          };
          doClientPublish(this, defaultProfile, params);
        } else {
          showError(this.#i18n?.t('error_noDefaultProfile') ?? 'No default profile found.');
        }
      }
    });

    this.addCommand({
      id: 'quickPublish',
      name: this.#i18n.t('command_quickPublish'),
      editorCallback: () => {
        this.quickPublish();
      }
    });

    this.addCommand({
      id: 'publish',
      name: this.#i18n.t('command_publish'),
      editorCallback: () => {
        this.openProfileChooser();
      }
    });

    this.addSettingTab(new WordpressSettingTab(this));
  }

  async loadSettings() {
    Logger.log('loadSettings: loading plugin data');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    Logger.verbose('loadSettings: raw settings', this.settings);
    const { needUpgrade, settings } = await upgradeSettings(this.settings, SettingsVersion.V2);
    this.settings = settings;
    if (needUpgrade) {
      Logger.log('loadSettings: settings upgraded to V2, saving');
      await this.saveSettings();
    }

    const crypto = new PassCrypto();
    const count = this.settings.profiles.length ?? 0;
    Logger.verbose('loadSettings: decrypting passwords for', count, 'profile(s)');
    for (let i = 0; i < count; i++) {
      const profile = this.settings.profiles[i];
      const enPass = profile.encryptedPassword;
      if (enPass) {
        Logger.verbose('loadSettings: decrypting password for profile', profile.name);
        profile.password = await crypto.decrypt(enPass.encrypted, enPass.key, enPass.vector);
      }
    }

    AppState.markdownParser.set({
      html: this.settings.enableHtml ?? false
    });
    Logger.log('loadSettings: complete, profiles loaded:', count);
  }

  async saveSettings() {
    Logger.log('saveSettings: saving plugin data');
    const settings = cloneDeep(this.settings);
    for (let i = 0; i < settings.profiles.length; i++) {
      const profile = settings.profiles[i];
      const password = profile.password;
      if (password) {
        Logger.verbose('saveSettings: encrypting password for profile', profile.name);
        const crypto = new PassCrypto();
        profile.encryptedPassword = await crypto.encrypt(password);
        delete profile.password;
      }
    }
    await this.saveData(settings);
    Logger.verbose('saveSettings: complete');
  }

  updateRibbonIcon(): void {
    const ribbonIconTitle = this.#i18n?.t('ribbon_iconTitle') ?? 'WordPress';
    if (this.settings.showRibbonIcon) {
      if (!this.ribbonWpIcon) {
        this.ribbonWpIcon = this.addRibbonIcon('wp-logo', ribbonIconTitle, () => {
          this.openProfileChooser();
        });
      }
    } else {
      if (this.ribbonWpIcon) {
        this.ribbonWpIcon.remove();
        this.ribbonWpIcon = null;
      }
    }
  }

  private async quickPublish() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      showError(this.i18n.t('error_noActiveFile'));
      return;
    }
    const { matter } = await processFile(file, this.app);

    // Resolve profile: frontmatter > default > only profile
    let profile = this.settings.profiles.find(p => matter.profileName && p.name === matter.profileName)
      ?? this.settings.profiles.find(p => p.isDefault)
      ?? (this.settings.profiles.length === 1 ? this.settings.profiles[0] : undefined);

    if (!profile) {
      showError(this.i18n.t('error_noDefaultProfile'));
      return;
    }

    const params: WordPressPostParams = {
      status: this.settings.defaultPostStatus ?? PostStatus.Draft,
      commentStatus: this.settings.defaultCommentStatus ?? CommentStatus.Open,
      categories: profile.lastSelectedCategories ?? [ 1 ],
      postType: PostTypeConst.Post,
      tags: [],
      title: '',
      content: '',
    };
    doClientPublish(this, profile, params);
  }

  private async openProfileChooser() {
    if (this.settings.profiles.length === 1) {
      doClientPublish(this, this.settings.profiles[0]);
    } else if (this.settings.profiles.length > 1) {
      const profile = await openProfileChooserModal(this);
      doClientPublish(this, profile);
    } else {
      showError(this.i18n.t('error_noProfile'));
    }
  }

  private registerProtocolHandler(): void {
    this.registerObsidianProtocolHandler(WP_OAUTH2_URL_ACTION, async (e) => {
      if (e.action === WP_OAUTH2_URL_ACTION) {
        if (e.state) {
          if (e.error) {
            showError(this.i18n.t('error_wpComAuthFailed', {
              error: e.error,
              desc: e.error_description.replace(/\+/g,' ')
            }));
            AppState.events.trigger(EventType.OAUTH2_TOKEN_GOT, undefined);
          } else if (e.code) {
            const token = await OAuth2Client.getWpOAuth2Client(this).getToken({
              code: e.code,
              redirectUri: WP_OAUTH2_REDIRECT_URI,
              codeVerifier: AppState.codeVerifier
            });
            Logger.log(token);
            AppState.events.trigger(EventType.OAUTH2_TOKEN_GOT, token);
          }
        }
      }
    });
  }

}
