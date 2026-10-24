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
