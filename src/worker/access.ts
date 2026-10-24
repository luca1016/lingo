import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

/** Access 設定(wrangler の vars)。どれかが空なら全経路を拒否する。 */
export interface AccessConfig {
  teamDomain: string;
  aud: string;
  allowedEmail: string;
}

/**
 * チームドメインから JWKS 取得関数を返す。テストで差し替えてよいのはこの関数だけ
 * (署名・issuer・audience・期限・email の検証経路は本番と同じものを通す)。
 */
export type JwksResolver = (issuer: string) => JWTVerifyGetKey;

const remoteJwksCache = new Map<string, JWTVerifyGetKey>();

/** 本番の JWKS 取得: https://<team>.cloudflareaccess.com/cdn-cgi/access/certs(isolate 内でキャッシュ)。 */
export const remoteJwks: JwksResolver = (issuer) => {
  let jwks = remoteJwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteJwksCache.set(issuer, jwks);
  }
  return jwks;
};

/** `myteam` / `myteam.cloudflareaccess.com` / `https://myteam.cloudflareaccess.com` のどれでも issuer に正規化する。 */
export function issuerFromTeamDomain(teamDomain: string): string {
  const host = teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return `https://${host.includes(".") ? host : `${host}.cloudflareaccess.com`}`;
}

/** env の vars から設定を読む。1 つでも空なら null(= 拒否)。 */
export function readAccessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
}): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const aud = env.ACCESS_AUD?.trim() ?? "";
  const allowedEmail = env.ALLOWED_EMAIL?.trim() ?? "";
  if (!teamDomain || !aud || !allowedEmail) return null;
  return { teamDomain, aud, allowedEmail };
}

/** Access JWT を検証し、許可メールと一致すればそのメールを返す。失敗は null。 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  jwks: JwksResolver,
): Promise<string | null> {
  const issuer = issuerFromTeamDomain(config.teamDomain);
  try {
    const { payload } = await jwtVerify(token, jwks(issuer), {
      issuer,
      audience: config.aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "email"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return email !== "" && email === config.allowedEmail.toLowerCase() ? email : null;
  } catch {
    return null;
  }
}

export type AccessVariables = { accessEmail: string };

/** Cf-Access-Jwt-Assertion ヘッダ(無ければ CF_Authorization cookie)を必須検証するミドルウェア。 */
export function accessAuth(
  jwks: JwksResolver,
): MiddlewareHandler<{ Bindings: Env; Variables: AccessVariables }> {
  return async (c, next) => {
    const config = readAccessConfig(c.env);
    if (!config) return c.text("Forbidden", 403);
    const token = c.req.header("Cf-Access-Jwt-Assertion") || getCookie(c, "CF_Authorization");
    if (!token) return c.text("Forbidden", 403);
    const email = await verifyAccessJwt(token, config, jwks);
    if (!email) return c.text("Forbidden", 403);
    c.set("accessEmail", email);
    await next();
  };
}
