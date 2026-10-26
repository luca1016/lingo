import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // wrangler.jsonc(本番と同じ設定)を読み、ローカル D1 に migrations/ を適用してから走らせる
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
      },
    })),
  ],
  // 画面のテスト(test/app.test.ts)は src/client の .tsx を読み込む。
  // 本番の束ね(vite.config.ts)と同じく JSX は preact へ向ける。
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
