import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { createApp } from "../src/worker/app";

// API のテスト用に、Access を通った状態を作る足場(差し替えるのは JWKS 取得関数だけ)。
// 検証経路(署名・issuer・aud・期限・email)は本番と同じものを通る。

export const TEAM = "lingo-test";
export const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
export const AUD = "test-aud-0123456789";
export const EMAIL = "me@example.com";
export const ORIGIN = "https://lingo.example.com";

export interface AccessHarness {
  app: ReturnType<typeof createApp>;
  /** 有効な Access JWT。 */
  jwt: string;
  /** vars を入れた Env(ASSETS は委譲の確認用スタブ)。 */
  env: Env;
}

/** `now` を基準にした有効な JWT と、設定済みの Env を持つ app を作る。 */
export async function createAccessHarness(now: Date): Promise<AccessHarness> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const nowSec = Math.floor(now.getTime() / 1000);

  const jwt = await new SignJWT({ email: EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject("user-1")
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(nowSec + 3600)
    .sign(privateKey);

  return {
    app: createApp({ jwks: () => createLocalJWKSet({ keys: [publicJwk] }) }),
    jwt,
    env: {
      ...env,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ALLOWED_EMAIL: EMAIL,
      ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    },
  };
}
