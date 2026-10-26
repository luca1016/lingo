// 復習画面(スマホ 1 カラム)。残り枚数 → 表 → めくる → Again / Hard / Good / Easy。
// 状態はモジュールのストア(review.ts)が持ち、ここは描画と押下の受け渡しだけ
//(コンポーネントは状態を持たないので、タブを往復しても送信状態と再送キーがそのまま残る)。

import { useEffect, useState } from "preact/hooks";
import { RATINGS, type ReviewRating } from "../shared/review";
import {
  canRate,
  formatWait,
  getSession,
  isLoading,
  isSending,
  needsRelogin,
  next,
  rate,
  resend,
  reveal,
  subscribe,
  unresolved,
} from "./review";

const button = { padding: "10px 16px", marginTop: "12px", fontSize: "16px" };
const rateButton = { padding: "14px 4px", marginTop: "12px", fontSize: "16px", flex: "1" };
const front = { fontSize: "28px", margin: "24px 0 8px", wordBreak: "break-word" } as const;
const back = { fontSize: "20px", margin: "8px 0" };
const sub = { fontSize: "14px", color: "#444" };
const ng = { color: "#b00020" };

/** 1=Again 2=Hard 3=Good 4=Easy(送る値と表示の対応)。 */
const RATING_LABELS: Record<ReviewRating, string> = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
};

/** ストアを購読して、変わったら描き直す。 */
function useSession() {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  return getSession();
}

export function Review() {
  const session = useSession();
  // 待ち時間の表示は時計で変わる。1 秒ごとに読み直す。
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 画面を開いた / 作り直した(MOUNT)。ストアの状態をそのまま描き、
  // 表示中の 1 枚も未確定の 1 件も無いときだけ訊きに行く(その判断は NEXT が持つ)。
  useEffect(() => {
    void next();
  }, []);

  // 待ち時間が来たら訊き直す(表示中・送信中・未確定のときは NEXT 側で無視される)。
  useEffect(() => {
    if (session.waitUntil !== null && Date.parse(session.waitUntil) <= now) void next();
  }, [now, session.waitUntil]);

  if (needsRelogin(session)) {
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

  const current = session.current;
  const held = unresolved(session);
  const waitUntil = session.waitUntil === null ? null : Date.parse(session.waitUntil);

  return (
    <section>
      <h2>復習</h2>
      <p>
        残り {session.remaining ?? 0} 枚
        {session.newRemaining !== null ? ` / 今日の新規はあと ${session.newRemaining} 枚` : ""}
      </p>

      {current ? (
        <article>
          <p style={front}>{current.card.front}</p>
          {/* 裏と評価ボタンは、表示中の 1 枚にだけ付く(別のカードには付け替わらない)。 */}
          {session.revealedAt !== null ? (
            <>
              <p style={back}>{current.card.back}</p>
              {current.card.example ? <p style={sub}>{current.card.example}</p> : null}
              {current.card.note ? <p style={sub}>{current.card.note}</p> : null}
              <div style={{ display: "flex", gap: "8px" }}>
                {RATINGS.map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    style={rateButton}
                    disabled={!canRate(session)}
                    onClick={() => void rate(rating, new Date())}
                  >
                    {RATING_LABELS[rating]}
                  </button>
                ))}
              </div>
              {isSending(session) ? <p style={sub}>送信中は評価を受け付けない</p> : null}
            </>
          ) : (
            <button type="button" style={button} onClick={() => reveal(Date.now())}>
              めくる
            </button>
          )}
        </article>
      ) : isLoading(session) ? (
        <p>読み込み中…</p>
      ) : session.fetchError !== null ? (
        <section>
          <p style={ng}>{session.fetchError}</p>
          <button type="button" style={button} onClick={() => void next()}>
            取り直す
          </button>
        </section>
      ) : waitUntil !== null ? (
        <p>つぎのカードまで あと {formatWait(waitUntil - now)}</p>
      ) : (
        <>
          <p>いま出すカードは無い</p>
          <button type="button" style={button} onClick={() => void next()}>
            取り直す
          </button>
        </>
      )}

      {/* 結果が分からない 1 件。できるのは同じ本文の再送だけ(次のカードには進まない)。 */}
      {held ? (
        <section>
          <p style={ng}>送信を確認できません — {held.reason?.message}</p>
          <button type="button" style={button} onClick={() => void resend()}>
            再送
          </button>
        </section>
      ) : null}
    </section>
  );
}
