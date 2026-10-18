import Link from "next/link";
import type { ReactNode } from "react";

import { parseInline, type InlineNode } from "@/content/poleznoe/inline";

/**
 * Строчная разметка статьи → React.
 *
 * Весь текст выводится как дети React, то есть экранируется: ни `<script>`, ни
 * HTML из текста статьи разметкой не станет, и dangerouslySetInnerHTML здесь
 * нет. Внутренние ссылки идут через next/link (предзагрузка, без перезагрузки
 * страницы), внешние открываются в новой вкладке с rel="noopener".
 */

function renderNodes(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.kind === "text") return node.text;
    const children = renderNodes(node.children);
    if (node.kind === "bold") return <strong key={i}>{children}</strong>;
    if (node.external) {
      return (
        <a key={i} href={node.href} rel="noopener" target="_blank">
          {children}
        </a>
      );
    }
    return (
      <Link key={i} href={node.href}>
        {children}
      </Link>
    );
  });
}

export function Inline({ text }: { text: string }) {
  return <>{renderNodes(parseInline(text))}</>;
}
