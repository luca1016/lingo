import { useState } from "preact/hooks";
import {
  type ImportResponse,
  MAX_CARDS_PER_IMPORT,
  type NormalizedCard,
  normalizeRow,
  normalizeRows,
  type RowError,
} from "../shared/cards";
import { newImportId, postCards } from "./api";
import { parseCards } from "./parse";

const page = { fontFamily: "system-ui, sans-serif", padding: "16px", maxWidth: "640px" };
const field = { display: "block", width: "100%", boxSizing: "border-box", padding: "8px" } as const;
const label = { display: "block", marginTop: "12px", fontSize: "14px" };
const button = { padding: "10px 16px", marginTop: "12px", fontSize: "16px" };
const row = { borderBottom: "1px solid #ddd", padding: "6px 0", fontSize: "14px" };
const ng = { color: "#b00020" };
const warn = { color: "#8a6d00" };

type Mode = "single" | "paste";

export function App() {
  const [mode, setMode] = useState<Mode>("single");
  return (
    <main style={page}>
      <h1>lingo</h1>
      <nav style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          style={button}
          disabled={mode === "single"}
          onClick={() => setMode("single")}
        >
          単票追加
        </button>
        <button
          type="button"
          style={button}
          disabled={mode === "paste"}
          onClick={() => setMode("paste")}
        >
          貼り付け取り込み
        </button>
      </nav>
      {mode === "single" ? <SingleCard /> : <PasteImport />}
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

/** 送信中・失敗の表示をまとめた状態。 */
interface SendState {
  sending: boolean;
  failure: string | null;
  errors: RowError[];
  result: ImportResponse | null;
}

const IDLE: SendState = { sending: false, failure: null, errors: [], result: null };

async function send(
  importId: string,
  cards: readonly NormalizedCard[],
  setState: (next: SendState) => void,
): Promise<boolean> {
  setState({ ...IDLE, sending: true });
  try {
    const res = await postCards(importId, cards);
    if (res.ok) {
      setState({ ...IDLE, result: res.response });
      return true;
    }
    setState({
      ...IDLE,
      failure: `${res.error.message}(${res.error.error})`,
      errors: res.error.errors ?? [],
    });
  } catch (cause) {
    // postCards は例外を出さない作りだが、万一出ても送信中のまま固まらせない
    //(import_id と入力は呼び出し側が保持しているので、そのまま再送できる)。
    setState({ ...IDLE, failure: `送信できなかった(${String(cause)})` });
  }
  return false;
}

function SingleCard() {
  const [values, setValues] = useState({ front: "", back: "", example: "", note: "" });
  const [importId, setImportId] = useState(newImportId);
  const [state, setState] = useState<SendState>(IDLE);

  const local = normalizeRow(values, 1);
  const [showErrors, setShowErrors] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setShowErrors(true);
    if (!local.card) return;
    if (await send(importId, [local.card], setState)) {
      // 追加できたら次の 1 枚へ。冪等キーも新しくする(同じキーの再送は増やさないため)。
      setValues({ front: "", back: "", example: "", note: "" });
      setImportId(newImportId());
      setShowErrors(false);
    }
  };

  const input = (name: keyof typeof values, text: string, rows?: number) => (
    <label style={label}>
      {text}
      {rows ? (
        <textarea
          style={field}
          rows={rows}
          value={values[name]}
          onInput={(e) => setValues({ ...values, [name]: e.currentTarget.value })}
        />
      ) : (
        <input
          style={field}
          value={values[name]}
          onInput={(e) => setValues({ ...values, [name]: e.currentTarget.value })}
        />
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
      <button type="submit" style={button} disabled={state.sending}>
        {state.sending ? "送信中…" : "追加する"}
      </button>
      {state.failure ? <p style={ng}>{state.failure}</p> : null}
      <RowErrors errors={state.errors} />
      {state.result ? <ImportResult result={state.result} /> : null}
    </form>
  );
}

interface Preview {
  importId: string;
  cards: NormalizedCard[];
  errors: RowError[];
  /** 行ごとの表示(検証結果つき)。 */
  rows: { row: number; front: string; back: string; errors: RowError[] }[];
  delimiter: string;
  header: string[] | null;
  tooMany: boolean;
}

function buildPreview(text: string): Preview {
  const parsed = parseCards(text);
  const { cards, errors } = normalizeRows(parsed.rows);
  return {
    importId: newImportId(),
    cards,
    errors,
    rows: parsed.rows.map((r, index) => ({
      row: index + 1,
      front: String(r.front ?? ""),
      back: String(r.back ?? ""),
      errors: errors.filter((e) => e.row === index + 1),
    })),
    delimiter: parsed.delimiter === "\t" ? "TSV(タブ区切り)" : "CSV(カンマ区切り)",
    header: parsed.header,
    tooMany: parsed.rows.length > MAX_CARDS_PER_IMPORT,
  };
}

function PasteImport() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [state, setState] = useState<SendState>(IDLE);

  const confirm = async () => {
    if (!preview || preview.errors.length > 0 || preview.tooMany || preview.cards.length === 0) {
      return;
    }
    if (await send(preview.importId, preview.cards, setState)) setPreview(null);
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
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <button
        type="button"
        style={button}
        onClick={() => {
          setState(IDLE);
          setPreview(buildPreview(text));
        }}
      >
        プレビュー
      </button>

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
            disabled={
              state.sending ||
              preview.errors.length > 0 ||
              preview.tooMany ||
              preview.cards.length === 0
            }
            onClick={confirm}
          >
            {state.sending ? "送信中…" : `${preview.cards.length} 件を取り込む`}
          </button>
        </section>
      ) : null}

      {state.failure ? <p style={ng}>{state.failure}</p> : null}
      <RowErrors errors={state.errors} />
      {state.result ? <ImportResult result={state.result} /> : null}
    </section>
  );
}
