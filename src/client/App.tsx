import { useMemo, useState } from "preact/hooks";
import {
  type ImportResponse,
  MAX_CARDS_PER_IMPORT,
  normalizeRow,
  type RowError,
} from "../shared/cards";
import {
  type Draft,
  type DraftContent,
  editDraft,
  isLocked,
  newDraft,
  resetDraft,
  submitDraft,
} from "./draft";
import { buildPreview, canImport } from "./preview";
import { Review } from "./Review";
import { newSession } from "./review";

const page = { fontFamily: "system-ui, sans-serif", padding: "16px", maxWidth: "640px" };
const field = { display: "block", width: "100%", boxSizing: "border-box", padding: "8px" } as const;
const label = { display: "block", marginTop: "12px", fontSize: "14px" };
const button = { padding: "10px 16px", marginTop: "12px", fontSize: "16px" };
const row = { borderBottom: "1px solid #ddd", padding: "6px 0", fontSize: "14px" };
const ng = { color: "#b00020" };
const warn = { color: "#8a6d00" };

type Mode = "single" | "paste" | "review";

/** 草稿を更新する(useState の setter をそのまま渡す)。 */
type SetDraft = (next: Draft | ((prev: Draft) => Draft)) => void;

const EMPTY_CARD: DraftContent = { front: "", back: "", example: "", note: "" };
const EMPTY_PASTE: DraftContent = { text: "" };

const TABS: [Mode, string][] = [
  ["single", "単票追加"],
  ["paste", "貼り付け取り込み"],
  ["review", "復習"],
];

export function App() {
  const [mode, setMode] = useState<Mode>("single");
  // 草稿(入力内容と import_id の組)は App が持つ。画面を切り替えても消えないので、
  // 送信中や応答が消えたあとにタブを往復しても、同じ内容・同じキーで再送して結果を確認できる。
  const [single, setSingle] = useState(() => newDraft(EMPTY_CARD));
  const [showErrors, setShowErrors] = useState(false);
  const [paste, setPaste] = useState(() => newDraft(EMPTY_PASTE));
  const [previewed, setPreviewed] = useState<string | null>(null);
  // 復習の進行(待ち行列・送信中の 1 件)も App が持つ。タブを往復しても短期カードの
  // 待ちや残り枚数を失わない。
  const [session, setSession] = useState(() => ({ ...newSession(), loading: true }));

  return (
    <main style={page}>
      <h1>lingo</h1>
      <nav style={{ display: "flex", gap: "8px" }}>
        {TABS.map(([value, text]) => (
          <button
            key={value}
            type="button"
            style={button}
            disabled={mode === value}
            onClick={() => setMode(value)}
          >
            {text}
          </button>
        ))}
      </nav>
      {mode === "single" ? (
        <SingleCard
          draft={single}
          setDraft={setSingle}
          showErrors={showErrors}
          setShowErrors={setShowErrors}
        />
      ) : mode === "paste" ? (
        <PasteImport
          draft={paste}
          setDraft={setPaste}
          previewed={previewed}
          setPreviewed={setPreviewed}
        />
      ) : (
        <Review session={session} setSession={setSession} />
      )}
    </main>
  );
}

/** 取り込み結果(追加したか / しなかったかを行ごとに出す)。 */
function ImportResult({ result }: { result: ImportResponse }) {
  return (
    <section>
      <p>
        追加 {result.added} 件 / 重複で追加しなかった {result.skipped} 件
      </p>
      <ul style={{ paddingLeft: "20px" }}>
        {result.results.map((item) => (
          <li key={`${item.row}-${item.front}`} style={item.added ? undefined : warn}>
            {item.row} 行目「{item.front}」:
            {item.added ? "追加した" : "既にある front なので追加していない(上書きもしない)"}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RowErrors({ errors }: { errors: readonly RowError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul style={{ paddingLeft: "20px", ...ng }}>
      {errors.map((e) => (
        <li key={`${e.row}-${e.field}-${e.code}`}>
          {e.row} 行目{e.field ? `(${e.field})` : ""}: {e.message}
        </li>
      ))}
    </ul>
  );
}

/** 送信の失敗・結果の表示(両方の画面で同じ)。 */
function SendState({ draft }: { draft: Draft }) {
  return (
    <>
      {draft.failure ? <p style={ng}>{draft.failure}</p> : null}
      <RowErrors errors={draft.errors} />
      {draft.result ? <ImportResult result={draft.result} /> : null}
    </>
  );
}

function SingleCard({
  draft,
  setDraft,
  showErrors,
  setShowErrors,
}: {
  draft: Draft;
  setDraft: SetDraft;
  showErrors: boolean;
  setShowErrors: (next: boolean) => void;
}) {
  const values = draft.content;
  const local = normalizeRow(values, 1);
  const locked = isLocked(draft);

  const submit = async (event: Event) => {
    event.preventDefault();
    setShowErrors(true);
    if (locked || !local.card) return;
    if (await submitDraft(draft, [local.card], setDraft)) {
      // 追加できたら次の 1 枚へ。内容が変わるので import_id も新しくなる(同じキーの再送は増やさない)。
      setDraft((prev) => resetDraft(prev, EMPTY_CARD));
      setShowErrors(false);
    }
  };

  const edit = (name: string) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setDraft((prev) => editDraft(prev, { ...prev.content, [name]: value }));
  };

  const input = (name: keyof typeof EMPTY_CARD, text: string, rows?: number) => (
    <label style={label}>
      {text}
      {rows ? (
        <textarea
          style={field}
          rows={rows}
          value={values[name]}
          disabled={locked}
          onInput={edit(name)}
        />
      ) : (
        <input style={field} value={values[name]} disabled={locked} onInput={edit(name)} />
      )}
    </label>
  );

  return (
    <form onSubmit={submit}>
      <h2>単票追加</h2>
      {input("front", "表(単語)")}
      {input("back", "裏(意味)")}
      {input("example", "例文(任意)", 2)}
      {input("note", "メモ(任意)", 2)}
      {showErrors ? <RowErrors errors={local.errors} /> : null}
      <button type="submit" style={button} disabled={locked}>
        {locked ? "送信中…" : "追加する"}
      </button>
      {locked ? <p style={{ fontSize: "14px" }}>送信が終わるまで入力は変えられない</p> : null}
      <SendState draft={draft} />
    </form>
  );
}

// previewed はプレビューした時点の文字列。いまの入力と一致しているあいだだけプレビューを出す
//(入力を変えたら import_id も変わるので、古いプレビューの内容を送らないようにする)。
function PasteImport({
  draft,
  setDraft,
  previewed,
  setPreviewed,
}: {
  draft: Draft;
  setDraft: SetDraft;
  previewed: string | null;
  setPreviewed: (next: string | null) => void;
}) {
  const text = draft.content.text ?? "";
  const locked = isLocked(draft);
  const fresh = previewed !== null && previewed === text;
  const preview = useMemo(() => (fresh ? buildPreview(text) : null), [fresh, text]);

  const confirm = async () => {
    if (locked || !preview || !canImport(preview)) return;
    if (await submitDraft(draft, preview.cards, setDraft)) {
      setPreviewed(null);
      setDraft((prev) => resetDraft(prev, EMPTY_PASTE));
    }
  };

  return (
    <section>
      <h2>貼り付け取り込み</h2>
      <p style={{ fontSize: "14px" }}>
        TSV / CSV を貼る(1 列目 = 表、2 列目 = 裏、3 列目 = 例文、4 列目 = メモ。 front / back
        などのヘッダ行があればその並びに従う)。1 回 {MAX_CARDS_PER_IMPORT} 件まで。
      </p>
      <textarea
        style={{ ...field, fontFamily: "monospace" }}
        rows={8}
        value={text}
        disabled={locked}
        onInput={(e) => {
          const value = e.currentTarget.value;
          setDraft((prev) => editDraft(prev, { text: value }));
        }}
      />
      <button type="button" style={button} disabled={locked} onClick={() => setPreviewed(text)}>
        プレビュー
      </button>
      {locked ? <p style={{ fontSize: "14px" }}>送信が終わるまで入力は変えられない</p> : null}
      {previewed !== null && !fresh ? (
        <p style={ng}>入力が変わった。もう一度プレビューしてから取り込む</p>
      ) : null}

      {preview ? (
        <section>
          <h3>
            プレビュー({preview.delimiter} / {preview.rows.length} 行
            {preview.header ? " / ヘッダ行あり" : ""})
          </h3>
          {preview.tooMany ? (
            <p style={ng}>{MAX_CARDS_PER_IMPORT} 件を超えているので分けて取り込む</p>
          ) : null}
          {preview.errors.length > 0 ? (
            <p style={ng}>
              無効な行があるので取り込めない(1 行でも無効なら何も追加しない)。直して再プレビュー。
            </p>
          ) : null}
          <ol style={{ paddingLeft: "20px", listStyle: "none" }}>
            {preview.rows.map((r) => (
              <li key={r.row} style={row}>
                <span style={r.errors.length > 0 ? ng : undefined}>
                  {r.row}. {r.front} — {r.back}
                </span>
                {r.errors.length > 0 ? (
                  <div style={ng}>{r.errors.map((e) => e.message).join(" / ")}</div>
                ) : null}
              </li>
            ))}
          </ol>
          <button
            type="button"
            style={button}
            disabled={locked || !canImport(preview)}
            onClick={confirm}
          >
            {locked ? "送信中…" : `${preview.cards.length} 件を取り込む`}
          </button>
        </section>
      ) : null}

      <SendState draft={draft} />
    </section>
  );
}
