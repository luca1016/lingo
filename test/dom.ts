// 実画面(Preact)をテストから描画するための最小の DOM。
// workerd 上のテストには DOM が無く、依存は増やさない方針なので、Preact が触る分だけを自分で用意する
//(要素・テキスト節点の付け外し、属性、style、イベント、input の value / disabled)。
// 仕様どおりの DOM ではない。画面の状態遷移を押さえるために必要な範囲だけ。

import { type ComponentChild, options, render } from "preact";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** イベント(bubble は親へ順に上げるだけ)。 */
export interface FakeEvent {
  type: string;
  target: FakeNode;
  currentTarget: FakeNode;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type Listener = (event: FakeEvent) => void;

export class FakeNode {
  readonly nodeType: number;
  childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  readonly ownerDocument: FakeDocument;

  constructor(nodeType: number, ownerDocument: FakeDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const parent = this.parentNode;
    if (!parent) return null;
    return parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    child.remove();
    child.parentNode = this as unknown as FakeElement;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

export class FakeText extends FakeNode {
  data: string;

  constructor(data: string, ownerDocument: FakeDocument) {
    super(3, ownerDocument);
    this.data = data;
  }
}

export class FakeElement extends FakeNode {
  readonly localName: string;
  readonly namespaceURI: string;
  readonly attributes: { name: string; value: string }[] = [];
  readonly style: Record<string, string> & { cssText: string } = { cssText: "" };
  // 実 DOM の input と同じく、value / checked / disabled は属性ではなくプロパティで持つ
  //(Preact は `name in element` で判断するので、ここに宣言があることが大事)。
  value = "";
  checked = false;
  disabled = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(localName: string, namespaceURI: string, ownerDocument: FakeDocument) {
    super(1, ownerDocument);
    this.localName = localName;
    this.namespaceURI = namespaceURI;
  }

  setAttribute(name: string, value: unknown): void {
    const found = this.attributes.find((a) => a.name === name);
    if (found) found.value = String(value);
    else this.attributes.push({ name, value: String(value) });
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((a) => a.name === name)?.value ?? null;
  }

  removeAttribute(name: string): void {
    const at = this.attributes.findIndex((a) => a.name === name);
    if (at >= 0) this.attributes.splice(at, 1);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "") this.appendChild(new FakeText(value, this.ownerDocument));
  }

  /** 自分から親へ順に listener を呼ぶ(this は要素。Preact の eventProxy がそれを見る)。 */
  dispatch(event: FakeEvent): void {
    let node: FakeElement | null = this;
    while (node) {
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) {
        event.currentTarget = node;
        listener.call(node, event);
      }
      node = node.parentNode;
    }
  }
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;

  constructor() {
    super(9, undefined as unknown as FakeDocument);
    (this as { ownerDocument: FakeDocument | null }).ownerDocument = null;
    this.documentElement = new FakeElement("html", HTML_NS, this);
  }

  createElementNS(ns: string | null, name: string): FakeElement {
    return new FakeElement(name, ns ?? HTML_NS, this);
  }

  createElement(name: string): FakeElement {
    return this.createElementNS(HTML_NS, name);
  }

  createTextNode(data: string): FakeText {
    return new FakeText(String(data), this);
  }
}

// Preact の再描画は microtask に積まれる。テストでは自分で流して、描画後の DOM を見られるようにする。
const pending: (() => void)[] = [];
options.debounceRendering = (process) => {
  pending.push(process);
};

/** 溜まっている再描画と、送信の続き(応答本文の読み取りを含む)を流し切る。 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    while (pending.length > 0) pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 画面を描画して、根と操作の道具を返す。 */
export function mount(vnode: ComponentChild): FakeElement {
  const document = new FakeDocument();
  const root = document.documentElement;
  render(vnode, root as unknown as Element & { __k?: unknown });
  return root;
}

function walk(node: FakeNode, out: FakeElement[]): FakeElement[] {
  if (node instanceof FakeElement) out.push(node);
  for (const child of node.childNodes) walk(child, out);
  return out;
}

/** 条件に合う要素すべて(描画順)。 */
export function all(root: FakeNode, match: (el: FakeElement) => boolean): FakeElement[] {
  return walk(root, []).filter(match);
}

/** 要素とその下のテキスト(表示されている文字列)。 */
export function textOf(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(textOf).join("");
}

/** タグ名で探す。 */
export function byTag(root: FakeNode, tag: string): FakeElement[] {
  return all(root, (el) => el.localName === tag);
}

/** ラベルの文字列で入力欄を探す(label の中に input / textarea がある形)。 */
export function fieldByLabel(root: FakeNode, text: string): FakeElement {
  const label = byTag(root, "label").find((el) => textOf(el).includes(text));
  if (!label) throw new Error(`label が無い: ${text}`);
  const field = byTag(label, "input")[0] ?? byTag(label, "textarea")[0];
  if (!field) throw new Error(`入力欄が無い: ${text}`);
  return field;
}

/** 文字列を含む button を探す。 */
export function buttonByText(root: FakeNode, text: string): FakeElement {
  const found = byTag(root, "button").find((el) => textOf(el).includes(text));
  if (!found) throw new Error(`button が無い: ${text}`);
  return found;
}

function event(type: string, target: FakeNode): FakeEvent {
  const self: FakeEvent = {
    type,
    target,
    currentTarget: target,
    defaultPrevented: false,
    preventDefault() {
      self.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return self;
}

/** イベントを送る。disabled な要素(とその中)には送らない(ブラウザと同じ)。 */
export async function fire(el: FakeElement, type: string): Promise<void> {
  for (let node: FakeElement | null = el; node; node = node.parentNode) {
    if (node.disabled) return;
  }
  el.dispatch(event(type, el));
  await flush();
}

/** 入力する(disabled なら何も起きない)。 */
export async function type(el: FakeElement, value: string): Promise<void> {
  if (el.disabled) return;
  el.value = value;
  await fire(el, "input");
}

/** 押す。type="submit" の button なら、ブラウザと同じく form に submit を送る。 */
export async function click(el: FakeElement): Promise<void> {
  if (el.disabled) return;
  await fire(el, "click");
  if (el.localName !== "button" || el.getAttribute("type") !== "submit") return;
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (node.localName === "form") {
      await fire(node, "submit");
      return;
    }
  }
}
