import { Hono } from "hono";
import pkg from "../../package.json";
import { type AccessVariables, accessAuth, type JwksResolver, remoteJwks } from "./access";
import { postCards } from "./cards";
import { jsonSameOrigin } from "./guard";

export interface AppOptions {
  /** JWKS 取得関数。テスト以外では指定しない(既定 = Access の公開 JWKS)。 */
  jwks?: JwksResolver;
}

/** Worker 本体。/api/health 以外はすべて(静的アセット含む)Access JWT 必須。 */
export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

  // 認証外は health だけ。版情報以外は返さない。
  app.get("/api/health", (c) =>
    c.json({ ok: true, version: pkg.version, commit: c.env.GIT_SHA || null }),
  );

  app.use("*", accessAuth(options.jwks ?? remoteJwks));
  app.use("/api/*", jsonSameOrigin());

  // カードの取り込み(Issue 2)。
  app.post("/api/cards", postCards);

  // 残りの API の経路は以降の Issue でここに足す。
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  // 認証を通ったものだけ静的アセットへ委譲する(run_worker_first: true 前提)。
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
