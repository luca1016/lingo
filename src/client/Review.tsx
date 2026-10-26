// 復習画面(スマホ 1 カラム)。残り枚数 → 表 → めくる → Again / Hard / Good / Easy。
// 状態遷移と通信は review.ts / review-api.ts に置き、ここは見た目と押下の受け渡しだけ。

import { useEffect, useState } from "preact/hooks";
import { RATINGS, type ReviewRating } from "../shared/review";
import {
  currentCard,
  formatWait,
  isRevealed,
  loadDue,
  nextDueAt,
  rate,
  remaining,
  resend,
  reveal,
  type Session,
  type SetSession,
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

  // 画面を開いたら出題を取り直す(タブを往復しても、待っている短期カードは手元に残る)。
  // 送信中なら取り直さない(その応答で決まる)。結果が分からないまま離れていた場合も、送った
  // 1 件は残してあるので、ここで取り直したあと同じ review_id で結果を確定できる(loadDue)。
  //
  // 離れている間にサーバ側が変わっているので、前の画面の取得が進行中でも取り直す(force)。
  // 古いほうの応答は世代が合わなくなるので、後から返ってきても画面には入らない。
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

  const card = currentCard(session, now);
  const waitUntil = nextDueAt(session, now);
  const left = remaining(session);

  return (
    <section>
      <h2>復習</h2>
      <p>
        残り {left} 枚
        {session.newRemaining !== null ? ` / 今日の新規はあと ${session.newRemaining} 枚` : ""}
      </p>
      {session.notice ? <p style={warn}>{session.notice}</p> : null}

      {card ? (
        <article>
          <p style={front}>{card.front}</p>
          {/* 裏と評価ボタンは、めくったカード自身にだけ付ける(別のカードには付け替わらない)。 */}
          {isRevealed(session, card) ? (
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
                    disabled={session.sending || session.loading}
                    onClick={() => void rate(session, card, rating, setSession, new Date())}
                  >
                    {RATING_LABELS[rating]}
                  </button>
                ))}
              </div>
              {session.sending ? <p style={sub}>送信中は評価を受け付けない</p> : null}
            </>
          ) : (
            <button
              type="button"
              style={button}
              disabled={session.sending}
              onClick={() => setSession((prev) => reveal(prev, card))}
            >
              めくる
            </button>
          )}
        </article>
      ) : session.loading ? (
        <p>読み込み中…</p>
      ) : waitUntil ? (
        <p>つぎのカードまで あと {formatWait(waitUntil.getTime() - now.getTime())}</p>
      ) : session.failure ? // 取れなかっただけなので「無い」とは言わない(理由と取り直しは下の節で出す)。
      null : (
        <>
          <p>いま出すカードは無い</p>
          <button type="button" style={button} onClick={() => void loadDue(session, setSession)}>
            取り直す
          </button>
        </>
      )}

      {session.failure ? (
        <section>
          <p style={ng}>{session.failure}</p>
          {session.attempt ? (
            <button
              type="button"
              style={button}
              disabled={session.sending || session.loading}
              onClick={() => void resend(session, setSession)}
            >
              同じ評価をもう一度送る
            </button>
          ) : (
            <button
              type="button"
              style={button}
              disabled={session.loading}
              onClick={() => void loadDue(session, setSession)}
            >
              取り直す
            </button>
          )}
        </section>
      ) : null}
    </section>
  );
}
