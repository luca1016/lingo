// PWA の殻(Issue 6)。manifest の中身・index.html からの参照・Service Worker が無いことを、
// 配信されるファイルそのもの(?raw)で確かめる。
// dist/ は `pnpm build` の生成物で test の時点では無いので、build の入力(index.html と public/)を見る。

import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import icon192 from "../public/icons/icon-192.png?raw";
import icon512 from "../public/icons/icon-512.png?raw";
import manifestRaw from "../public/manifest.webmanifest?raw";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name: string;
  start_url: string;
  scope?: string;
  display: string;
  theme_color: string;
  background_color?: string;
  icons: ManifestIcon[];
}

const manifest = JSON.parse(manifestRaw) as Manifest;

// public/ の中身は Vite がそのまま dist/ へ出す(= manifest の src と同じ絶対パスで配信される)。
const publicFiles: Record<string, string> = {
  "/manifest.webmanifest": manifestRaw,
  "/icons/icon-192.png": icon192,
  "/icons/icon-512.png": icon512,
};

describe("Web App Manifest", () => {
  it("名前・standalone・start_url・テーマ色がある", () => {
    expect(manifest.name).toBe("lingo");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("192 と 512 の PNG アイコンがあり、実体が public/ にある", () => {
    expect(manifest.icons.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      // 実体があること(無ければこの test ファイルの取り込みが失敗する)と、中身が PNG であること
      expect(publicFiles[icon.src], icon.src).toBeDefined();
      expect(publicFiles[icon.src]?.slice(0, 8)).toContain("PNG");
    }
  });
});

describe("index.html からの参照", () => {
  it("manifest を参照している(Access の cookie を付けて取りに行く)", () => {
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toMatch(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/);
    expect(indexHtml).toMatch(/<link[^>]+rel="manifest"[^>]+crossorigin="use-credentials"/);
  });

  it("アイコンとテーマ色を参照していて、参照先が public/ にある", () => {
    const hrefs = [...indexHtml.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(hrefs).toContain("/icons/icon-192.png");
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    for (const href of hrefs) {
      expect(publicFiles[href], href).toBeDefined();
    }
    const theme = indexHtml.match(/<meta name="theme-color" content="([^"]+)"/)?.[1];
    expect(theme).toBe(manifest.theme_color);
  });
});

describe("Service Worker", () => {
  // SW は別 Issue。登録コードが紛れ込んでいないことを画面のソース全体で見る。
  const clientSources = import.meta.glob("../src/client/**/*.{ts,tsx}", {
    eager: true,
    query: "?raw",
    import: "default",
  });

  it("登録コードがどこにも無い", () => {
    expect(Object.keys(clientSources).length).toBeGreaterThan(0);
    for (const [path, source] of Object.entries({ ...clientSources, "index.html": indexHtml })) {
      expect(source, path).not.toMatch(/serviceWorker|navigator\.serviceWorker|workbox/i);
      expect(source, path).not.toMatch(/sw\.js|service-worker/i);
    }
  });
});
