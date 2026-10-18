import type { ArticleBlock } from "@/content/poleznoe/types";

import { CtaCard } from "./CtaCard";
import { Inline } from "./Inline";

/**
 * Тело статьи: каждый тип блока — свой элемент.
 *
 * Таблица лежит в собственном прокручиваемом контейнере: широкая таблица
 * прокручивается внутри колонки, а не раздвигает страницу (на телефоне иначе
 * появлялась горизонтальная прокрутка всей страницы). Контейнер доступен с
 * клавиатуры (tabIndex), иначе прокрутить его без мыши нельзя.
 */
export function ArticleBody({ blocks }: { blocks: readonly ArticleBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "p":
            return (
              <p key={i}>
                <Inline text={block.text} />
              </p>
            );
          case "h2":
            return (
              <h2 key={i} id={block.id}>
                {block.text}
              </h2>
            );
          case "h3":
            return <h3 key={i}>{block.text}</h3>;
          case "ul":
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline text={item} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline text={item} />
                  </li>
                ))}
              </ol>
            );
          case "table":
            return (
              <div
                key={i}
                className="pz-table-wrap"
                role="region"
                tabIndex={0}
                aria-label={block.caption ?? "Таблица"}
              >
                <table>
                  {block.caption && <caption>{block.caption}</caption>}
                  <thead>
                    <tr>
                      {block.head.map((cell, j) => (
                        <th key={j} scope="col">
                          <Inline text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>
                            <Inline text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "note":
            return (
              <div key={i} className="pz-note" role="note">
                {block.title && <p className="pz-note-title">{block.title}</p>}
                <p>
                  <Inline text={block.text} />
                </p>
              </div>
            );
          case "cta":
            return <CtaCard key={i} text={block.text} />;
        }
      })}
    </>
  );
}
