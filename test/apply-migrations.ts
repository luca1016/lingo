import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// ローカル D1 に migrations/ を適用する(適用済みは飛ばされるので各ファイルで呼んでよい)
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
