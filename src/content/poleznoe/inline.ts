/**
 * Строчная разметка статей: только **жирный** и [текст](ссылка).
 *
 * Зачем свой разбор, а не markdown-библиотека: статьи пишутся данными, и
 * разрешённый набор должен быть жёстким. Всё, что не распознано, остаётся
 * обычным текстом, а React сам его экранирует, поэтому `<script>` в тексте
 * статьи не может превратиться в разметку. Один разбор используют страница,
 * llms-full.txt и проверка статей, так что они не разойдутся.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "link"; href: string; external: boolean; children: InlineNode[] };

/** Либо **жирный**, либо [текст](адрес без пробелов). */
const TOKEN = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Внутренние адреса сайта и якоря: «/…» (но не «//…», это внешний хост) и «#…». */
export function isInternalHref(href: string): boolean {
  return (/^\/(?!\/)/.test(href)) || href.startsWith("#");
}

/** Внешние: только http(s) и mailto. Остальные схемы (javascript:, data:) ссылкой не становятся. */
export function isExternalHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(href);
}

interface Allow {
  bold: boolean;
  link: boolean;
}

/**
 * Разбирает строку в дерево. Жирный внутри ссылки и ссылка внутри жирного
 * допускаются (авторы пишут и так, и иначе), но не глубже одного уровня:
 * вложенность одноимённых конструкций смысла не имеет.
 */
export function parseInline(text: string, allow: Allow = { bold: true, link: true }): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  const push = (value: string): void => {
    if (value !== "") nodes.push({ kind: "text", text: value });
  };

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    const [whole, boldText, linkText, href] = match;
    const isBold = boldText !== undefined;
    // Конструкция, которая здесь не разрешена, остаётся текстом как есть.
    if ((isBold && !allow.bold) || (!isBold && !allow.link)) continue;

    push(text.slice(last, index));
    last = index + whole.length;

    if (isBold) {
      nodes.push({ kind: "bold", children: parseInline(boldText, { bold: false, link: allow.link }) });
      continue;
    }
    const children = parseInline(linkText ?? "", { bold: allow.bold, link: false });
    const target = href ?? "";
    if (isInternalHref(target)) nodes.push({ kind: "link", href: target, external: false, children });
    else if (isExternalHref(target)) nodes.push({ kind: "link", href: target, external: true, children });
    // Небезопасный адрес: оставляем только подпись, без ссылки.
    else nodes.push(...children);
  }
  push(text.slice(last));
  return nodes;
}

interface PlainOptions {
  /** Дописывать адрес ссылки в скобках (для llms-full.txt, где нет кликабельности). */
  withUrls?: boolean;
  /** База для относительных адресов; нужна вместе с withUrls. */
  base?: string;
}

function nodesToPlain(nodes: InlineNode[], options: PlainOptions): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.text;
      const inner = nodesToPlain(node.children, options);
      if (node.kind === "bold") return inner;
      if (!options.withUrls || node.href.startsWith("#")) return inner;
      const url = node.external ? node.href : `${options.base ?? ""}${node.href}`;
      return `${inner} (${url})`;
    })
    .join("");
}

/** Текст без разметки: для JSON-LD, подсчёта времени чтения и llms-full.txt. */
export function inlineToPlain(text: string, options: PlainOptions = {}): string {
  return nodesToPlain(parseInline(text), options);
}

/** Все ссылки строки (для проверки статей). */
export function inlineLinks(text: string): { href: string; external: boolean }[] {
  const out: { href: string; external: boolean }[] = [];
  const walk = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "link") out.push({ href: node.href, external: node.external });
      if (node.kind !== "text") walk(node.children);
    }
  };
  walk(parseInline(text));
  return out;
}

/** Остаток текста без распознанных конструкций: по нему проверка находит «битую» разметку. */
export function inlineLeftovers(text: string): string {
  const flat = (nodes: InlineNode[]): string =>
    nodes.map((n) => (n.kind === "text" ? n.text : flat(n.children))).join("");
  return flat(parseInline(text));
}
