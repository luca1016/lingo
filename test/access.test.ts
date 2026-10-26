import { env, exports } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/worker/app";

// 固定時計(JWT の iat/exp と jose の検証時刻の両方がこれに従う)
const NOW = new Date("2026-10-24T03:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

const TEAM = "lingo-test";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "test-aud-0123456789";
const EMAIL = "me@example.com";
const ORIGIN = "https://lingo.example.com";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

afterAll(() => {
  vi.useRealTimers();
});

// 差し替えるのは JWKS 取得関数だけ。検証経路は本番と同じ。
const app = createApp({ jwks: () => createLocalJWKSet({ keys: [publicJwk] }) });

const configuredEnv = (overrides: Partial<Env> = {}): Env => ({
  ...env,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ALLOWED_EMAIL: EMAIL,
  // 静的アセットは Worker から委譲されたことだけ確かめる
  ASSETS: {
    fetch: async () => new Response("asset", { headers: { "x-from": "assets" } }),
  } as unknown as Fetcher,
  ...overrides,
});

interface TokenOptions {
  key?: CryptoKey;
  email?: string;
  aud?: string;
  issuer?: string;
  exp?: number;
}

function token(opts: TokenOptions = {}): Promise<string> {
  return new SignJWT({ email: opts.email ?? EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setSubject("user-1")
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(opts.exp ?? nowSec + 3600)
    .sign(opts.key ?? signingKey);
}

function get(path: string, headers: Record<string, string> = {}, e: Env = configuredEnv()) {
  return app.request(`${ORIGIN}${path}`, { headers }, e);
}

describe("/api/health", () => {
  it("認証なしで 200 と版情報を返す(実エントリポイント)", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; version: string }>();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("Access JWT", () => {
  it("JWT が無ければ静的アセットは 403、API 経路は 401(画面が再ログインを出せる)", async () => {
    expect((await get("/")).status).toBe(403);
    expect((await get("/index.html")).status).toBe(403);

    const api = await get("/api/anything");
    expect(api.status).toBe(401);
    expect((await api.json<{ error: string; message: string }>()).error).toBe("unauthenticated");
  });

  it("PWA の殻(manifest・アイコン)も認証なしなら 403、正しい JWT なら静的アセットから返る", async () => {
    for (const path of ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"]) {
      expect((await get(path)).status, path).toBe(403);

      const ok = await get(path, { "Cf-Access-Jwt-Assertion": await token() });
      expect(ok.status, path).toBe(200);
      expect(ok.headers.get("x-from"), path).toBe("assets");
    }
  });

  it("API 経路は検証に通らないトークン(期限切れ・別メール・署名不正)も 401", async () => {
    for (const opts of [
      { exp: nowSec - 1 },
      { email: "someone@example.com" },
      { key: otherKey },
      { aud: "other-aud" },
    ] satisfies TokenOptions[]) {
      const res = await get("/api/due", { "Cf-Access-Jwt-Assertion": await token(opts) });
      expect(res.status, JSON.stringify(opts)).toBe(401);
      expect((await res.json<{ error: string }>()).error).toBe("unauthenticated");
    }
  });

  it("設定(team / aud / email)のどれかが空なら正しい JWT でも 403", async () => {
    const jwt = await token();
    for (const key of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ALLOWED_EMAIL"] as const) {
      const res = await get("/", { "Cf-Access-Jwt-Assertion": jwt }, configuredEnv({ [key]: "" }));
      expect(res.status, key).toBe(403);
    }
  });

  it("設定が空なら API 経路も 403(再ログインでは直らないので 401 にしない)", async () => {
    const res = await get(
      "/api/due",
      { "Cf-Access-Jwt-Assertion": await token() },
      configuredEnv({ ACCESS_AUD: "" }),
    );
    expect(res.status).toBe(403);
  });

  it("実エントリポイントは設定が空(commit された wrangler.jsonc のまま)なので 403", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await token() },
    });
    expect(res.status).toBe(403);
  });

  it("署名が不正なら 403", async () => {
    const res = await get("/", { "Cf-Access-Jwt-Assertion": await token({ key: otherKey }) });
    expect(res.status).toBe(403);
  });

  it("改ざんされたペイロードは 403", async () => {
    const [h, , s] = (await token()).split(".");
    const forged = btoa(JSON.stringify({ email: EMAIL, iss: ISSUER, aud: AUD, exp: nowSec + 9999 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const res = await get("/", { "Cf-Access-Jwt-Assertion": `${h}.${forged}.${s}` });
    expect(res.status).toBe(403);
  });

  it("期限切れなら 403", async () => {
    const res = await get("/", { "Cf-Access-Jwt-Assertion": await token({ exp: nowSec - 1 }) });
    expect(res.status).toBe(403);
  });

  it("別メールのクレームなら 403", async () => {
    const res = await get("/", {
      "Cf-Access-Jwt-Assertion": await token({ email: "someone@example.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("audience / issuer が違えば 403", async () => {
    expect(
      (await get("/", { "Cf-Access-Jwt-Assertion": await token({ aud: "other-aud" }) })).status,
    ).toBe(403);
    expect(
      (
        await get("/", {
          "Cf-Access-Jwt-Assertion": await token({ issuer: "https://evil.cloudflareaccess.com" }),
        })
      ).status,
    ).toBe(403);
  });

  it("正しい JWT(ヘッダ)なら 200 で静的アセットに委譲する", async () => {
    const res = await get("/", { "Cf-Access-Jwt-Assertion": await token() });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-from")).toBe("assets");
  });

  it("正しい JWT(CF_Authorization cookie)でも 200", async () => {
    const res = await get("/", { Cookie: `CF_Authorization=${await token()}` });
    expect(res.status).toBe(200);
  });

  it("メールの大文字小文字は区別しない", async () => {
    const res = await get("/", {
      "Cf-Access-Jwt-Assertion": await token({ email: "Me@Example.com" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST の共通ガード", () => {
  async function post(headers: Record<string, string>) {
    return app.request(
      `${ORIGIN}/api/anything`,
      {
        method: "POST",
        body: "{}",
        headers: { "Cf-Access-Jwt-Assertion": await token(), ...headers },
      },
      configuredEnv(),
    );
  }

  it("Origin が無い・別 Origin なら 403", async () => {
    expect((await post({ "Content-Type": "application/json" })).status).toBe(403);
    expect(
      (await post({ "Content-Type": "application/json", Origin: "https://evil.example.com" }))
        .status,
    ).toBe(403);
  });

  it("JSON 以外の Content-Type は 415", async () => {
    expect((await post({ "Content-Type": "text/plain", Origin: ORIGIN })).status).toBe(415);
  });

  it("同一 Origin + JSON なら通過する(経路が無いので 404)", async () => {
    const res = await post({ "Content-Type": "application/json; charset=utf-8", Origin: ORIGIN });
    expect(res.status).toBe(404);
  });
});

describe("ローカル D1", () => {
  it("migration 済みの D1 に接続できる", async () => {
    const row = await env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    expect(row?.one).toBe(1);
  });
});
