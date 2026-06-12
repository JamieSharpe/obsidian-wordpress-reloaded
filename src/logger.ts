export class Logger {
  private static readonly env = process.env.NODE_ENV;
  private static readonly isProduction = Logger.env === 'production';
  private static readonly isDebug = Logger.env === 'debug';

  static log(...args: unknown[]): void {
    if (!Logger.isProduction) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  }

  static warn(...args: unknown[]): void {
    if (!Logger.isProduction) {
      // eslint-disable-next-line no-console
      console.warn(...args);
    }
  }

  static error(...args: unknown[]): void {
    // Errors should always be logged
    // eslint-disable-next-line no-console
    console.error(...args);
  }

  /** Only emitted in debug builds. Use for high-frequency or deeply detailed diagnostics. */
  static verbose(...args: unknown[]): void {
    if (Logger.isDebug) {
      // eslint-disable-next-line no-console
      console.debug('[verbose]', ...args);
    }
  }
}
