// 統計画面(スマホ 1 カラム)。4 つの数字を出すだけ。
// 読むだけの画面なので状態はコンポーネントが持つ(復習と違い、守るべき未確定の送信が無い)。
// 開いたときに 1 回取り、失敗したら理由を出して取り直せるようにする。

import { useEffect, useState } from "preact/hooks";
import type { StatsResponse } from "../shared/stats";
import { getStats } from "./stats-api";

const button = { padding: "10px 16px", marginTop: "12px", fontSize: "16px" };
const list = { display: "flex", flexWrap: "wrap", gap: "12px", padding: 0, margin: "16px 0" };
const cell = { flex: "1 1 40%", border: "1px solid #ddd", borderRadius: "8px", padding: "12px" };
const term = { fontSize: "14px", color: "#444" };
const number = { fontSize: "32px", margin: "4px 0 0" };
const ng = { color: "#b00020" };

type View =
  | { phase: "loading" }
  | { phase: "ready"; stats: StatsResponse }
  | { phase: "failed"; message: string; authExpired: boolean };

/** 表示する 4 指標(並び順もここで決める)。 */
const METRICS: [label: string, read: (stats: StatsResponse) => number][] = [
  ["今 due", (stats) => stats.due_now],
  ["今日中 due", (stats) => stats.due_today],
  ["総数", (stats) => stats.total],
  ["連続日数", (stats) => stats.streak_days],
];

export function Stats() {
  const [view, setView] = useState<View>({ phase: "loading" });
  // 取り直した回数。変わると下の useEffect が走って取り直す。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 画面を外したあとの応答は反映しない(取り直しの応答と行き違わないようにもする)。
    let live = true;
    setView({ phase: "loading" });
    void getStats().then((result) => {
      if (!live) return;
      if (result.ok) {
        setView({ phase: "ready", stats: result.response });
        return;
      }
      setView({
        phase: "failed",
        message: result.error.message,
        authExpired: result.error.error === "unauthenticated",
      });
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  return (
    <section>
      <h2>統計</h2>
      {view.phase === "loading" ? <p>読み込み中…</p> : null}

      {view.phase === "ready" ? (
        <dl style={list}>
          {METRICS.map(([label, read]) => (
            <div key={label} style={cell}>
              <dt style={term}>{label}</dt>
              <dd style={number}>{read(view.stats)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {view.phase === "failed" ? (
        <>
          <p style={ng}>{view.message}</p>
          {/* 認証切れは取り直しても通らないので、入り直してもらう(失うものは何も無い)。 */}
          {view.authExpired ? (
            <p>
              <a href="/">再読み込みしてログインし直す</a>
            </p>
          ) : (
            <button type="button" style={button} onClick={() => setAttempt((n) => n + 1)}>
              取り直す
            </button>
          )}
        </>
      ) : null}
    </section>
  );
}
