// 復習画面(スマホ 1 カラム)。残り枚数 → 表 → めくる → Again / Hard / Good / Easy。
// 状態遷移は review.ts の状態機械(reduce)、通信は review-api.ts。ここは見た目と押下の受け渡しだけ。

import { useEffect, useState } from "preact/hooks";
import { RATINGS, type ReviewRating } from "../shared/review";
import {
  canRate,
  currentCard,
  formatWait,
  isRevealed,
  isSendingNow,
  loadDue,
  nextDueAt,
  rate,
  reduce,
  remaining,
  resend,
  type Session,
  type SetSession,
  unresolved,
} from "./review";

const button = { padding: "10px 16px", marginTop: "12px", fontSize: "16px" };
const rateButton = { padding: "14px 4px", marginTop: "12px", fontSize: "16px", flex: "1" };
const front = { fontSize: "28px", margin: "24px 0 8px", wordBreak: "break-word" } as const;
const back = { fontSize: "20px", margin: "8px 0" };
const sub = { fontSize: "14px", color: "#444" };
const ng = { color: "#b00020" };
const warn = { color: "#8a6d00" };

/** 1=Again 2=Hard 3=Good 4=Easy(送る値と表示の対応)。 */
const RATING_LABELS: Record<ReviewRating, string> = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
};

export function Review({ session, setSession }: { session: Session; setSession: SetSession }) {
  // 短期カードの待ち時間は時計で変わる。1 秒ごとに読み直して、時間が来たらそのまま出す。
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // 期限が来た短期カードを出す。出している 1 枚・送っている 1 件には触らない(不変条件 B)。
  useEffect(() => {
    setSession((prev) => reduce(prev, { type: "tick", now: now.getTime() }));
  }, [now]);

  // 画面を開いたら出題を取り直す(離れている間にサーバ側が変わっている)。
  // 送信中は取りに行かないし、未確定の 1 件があるときは応答を保留するだけなので、
  // タブを往復しても送信状態・再送キー・短期カードは失われない(不変条件 A・B)。
  // 前の画面の取得が進行中でも取り直す(force)。古いほうの応答は世代が合わず捨てられる。
  useEffect(() => {
    void loadDue(session, setSession, { force: true });
  }, []);

  if (session.authExpired) {
    return (
      <section>
        <h2>復習</h2>
        <p style={ng}>ログインの有効期限が切れた。送信は止めた(二重に記録されることはない)。</p>
        <p>
          <a href="/">再読み込みしてログインし直す</a>
        </p>
      </section>
    );
  }

  const phase = session.phase;
  const card = currentCard(session);
  const held = unresolved(session);
  const waitUntil = nextDueAt(session, now);

  return (
    <section>
      <h2>復習</h2>
      <p>
        残り {remaining(session)} 枚
        {session.newRemaining !== null ? ` / 今日の新規はあと ${session.newRemaining} 枚` : ""}
      </p>
      {session.notice ? <p style={warn}>{session.notice}</p> : null}

      {card ? (
        <article>
          <p style={front}>{card.front}</p>
          {/* 裏と評価ボタンは、出している 1 枚にだけ付く(別のカードには付け替わらない)。 */}
          {isRevealed(session) ? (
            <>
              <p style={back}>{card.back}</p>
              {card.example ? <p style={sub}>{card.example}</p> : null}
              {card.note ? <p style={sub}>{card.note}</p> : null}
              <div style={{ display: "flex", gap: "8px" }}>
                {RATINGS.map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    style={rateButton}
                    disabled={!canRate(session, rating)}
                    onClick={() => void rate(session, card, rating, setSession, new Date())}
                  >
                    {RATING_LABELS[rating]}
                  </button>
                ))}
              </div>
              {isSendingNow(session) ? <p style={sub}>送信中は評価を受け付けない</p> : null}
              {held ? (
                <p style={sub}>
                  結果が分かるまで次のカードには進まない(同じ評価を送り直して確かめる)
                </p>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              style={button}
              onClick={() =>
                setSession((prev) =>
                  reduce(prev, { type: "reveal", cardId: card.cardId, now: Date.now() }),
                )
              }
            >
              めくる
            </button>
          )}
        </article>
      ) : phase.kind === "loading" ? (
        <p>読み込み中…</p>
      ) : waitUntil ? (
        <p>つぎのカードまで あと {formatWait(waitUntil.getTime() - now.getTime())}</p>
      ) : phase.kind === "done" ? (
        <>
          <p>いま出すカードは無い</p>
          <button type="button" style={button} onClick={() => void loadDue(session, setSession)}>
            取り直す
          </button>
        </>
      ) : // 取れなかっただけなので「無い」とは言わない(理由と取り直しは下の節で出す)。
      null}

      {held ? (
        <section>
          <p style={ng}>{held.reason}</p>
          <button type="button" style={button} onClick={() => void resend(session, setSession)}>
            同じ評価をもう一度送る
          </button>
        </section>
      ) : session.failure ? (
        <section>
          <p style={ng}>{session.failure}</p>
          <button
            type="button"
            style={button}
            disabled={session.fetching}
            onClick={() => void loadDue(session, setSession)}
          >
            取り直す
          </button>
        </section>
      ) : null}
    </section>
  );
}
