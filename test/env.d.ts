// Vite の生テキスト取り込み(test/pwa.test.ts が index.html や manifest をそのまま読む)。
// vite/client の型は入れていないので、使う分だけ書く。
declare module "*?raw" {
  const content: string;
  export default content;
}

interface ImportMeta {
  /** Vite の glob 取り込み。`{ eager: true, query: "?raw", import: "default" }` でだけ使う。 */
  glob(
    pattern: string,
    options: { eager: true; query: "?raw"; import: "default" },
  ): Record<string, string>;
}

declare namespace Cloudflare {
  // `exports.default` の型付け(main = src/worker/index.ts)
  interface GlobalProps {
    mainModule: typeof import("../src/worker/index");
  }
  // テスト専用の binding(vitest.config.ts で注入)
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
