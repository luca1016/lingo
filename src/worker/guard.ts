import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 状態を変えるリクエスト(POST 等)は JSON の Content-Type と同一 Origin を必須にする。 */
export function jsonSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      return c.json({ error: "cross_origin" }, 403);
    }
    const contentType = c.req.header("Content-Type") ?? "";
    if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    await next();
  };
}
