"use client";

import { useMemo, useState } from "react";

import { AddRowForm, parseDecimal, RowEditor, UnitSelect } from "@/components/estimate/BillRowEditor";
import { Badge, Button, Checkbox, Input } from "@/components/ui/primitives";
import { droppingGaps } from "@/domain/estimate/assurance";
import {
  editsWord,
  parseRejectedVolume,
  remainingRejected,
  restoreEdit,
  type BillEdit,
} from "@/domain/estimate/billEdits";
import {
  countToReview,
  generatedBadge,
  matchBadge,
  priceSourceLabel,
  type BillRowInfo,
} from "@/domain/estimate/billReview";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import type { BillOfWorkItem, EstimateLine } from "@/domain/estimate/types";
import { linesById, type BillEditor } from "@/hooks/useBillEdits";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/utils/format";

/**
 * «Ведомость и нормы»: каждая позиция расчёта с её нормой, источником цены и стоимостью.
 *
 * Расчёт сам выбирает норму под работу, и иногда ошибается: «Демонтаж наружных стен» → опалубка.
 * Таблица показывает выбор прямо, а слабые подборы подсвечивает «проверьте» — теми же порогами,
 * что и расчёт (`needsReview`). Отсюда же человек правит объём и единицу, выбирает другую норму
 * или называет свою цену, удаляет и добавляет строки и пересчитывает смету без модели.
 *
 * Раскладка одна для всех ширин: строка — карточка на телефоне и строка сетки от 768 px. Так
 * на 375 px нет ни горизонтальной прокрутки, ни второй копии разметки.
 */

const GRID =
  "md:grid md:grid-cols-[2rem_minmax(0,2.4fr)_5.5rem_minmax(0,2.2fr)_6rem_6.5rem_4.5rem] md:items-start md:gap-x-3";

const lineTotal = (line: EstimateLine): number => line.directCost + line.overheadCost + line.profitCost;

function positionsWord(count: number): string {
  const last = count % 10;
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return "позиций";
  if (last === 1) return "позиция";
  if (last >= 2 && last <= 4) return "позиции";
  return "позиций";
}

const rub = (value: number): string => `${formatNumber(Math.round(value))} ₽`;

function signed(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${formatNumber(rounded)} ₽`;
}

const REASON_LABELS: Record<string, string> = {
  EMPTY_NAME: "без наименования работы",
  BAD_QUANTITY: "объём не число",
  UNKNOWN_UNIT: "единица не распознана",
  MONEY_NOT_WORK: "сумма, а не работа",
  QUOTE_NOT_FOUND: "цитаты нет в документе",
  QUANTITY_QUOTE_NOT_FOUND: "фрагмента с объёмом нет в документе",
  QUANTITY_NOT_IN_QUOTE: "объём не виден в цитате",
  ANCHORS_TOO_FAR: "наименование и объём из разных мест",
  DUPLICATE: "повтор",
  NOT_WORK: "таблица не из работ (машины, кадры, СИЗ, график)",
  WHOLE_WORK: "объём задан всей работой (1 усл. ед.)",
  DUPLICATE_POSITION: "дубль позиции после распознавания",
  LOWER_SOURCE: "объём есть в источнике выше по приоритету",
};

export function BillTable({ editor }: { readonly editor: BillEditor }) {
  const { effective, base, desired, pendingIds } = editor;
  const [onlyReview, setOnlyReview] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const document = effective.document;
  const lines = useMemo(() => linesById(document), [document]);
  const rows = useMemo(
    () => new Map<string, BillRowInfo>((effective.bill?.rows ?? []).map((row) => [row.itemId, row] as const)),
    [effective.bill],
  );
  const baseItems = useMemo(
    () => new Map((base.bill?.sections ?? []).flatMap((section) => section.items).map((item) => [item.id, item] as const)),
    [base.bill],
  );
  const desiredItems = useMemo(
    () => new Map(desired.sections.flatMap((section) => section.items).map((item) => [item.id, item] as const)),
    [desired.sections],
  );
  const ownIds = useMemo(
    () => new Set(editor.edits.flatMap((edit) => (edit.kind === "add" || edit.kind === "restore" ? [edit.id] : []))),
    [editor.edits],
  );
  const marks = useMemo(() => new Map(editor.marks.map((mark) => [mark.itemId, mark] as const)), [editor.marks]);

  const sections = effective.bill?.sections ?? [];
  const shownLines = sections.flatMap((section) => section.items.flatMap((item) => lines.get(item.id) ?? []));
  const toReview = countToReview(shownLines, rows);

  // Позиции, у которых строки сметы нет: выпали из расчёта (нормы нет, единица не сошлась, объём плох).
  const dropped = sections.flatMap((section) => section.items).filter((item) => !lines.has(item.id));
  const dropGaps = droppingGaps(document);
  /*
    Причина выпадения словами из пробелов документа. Пробел находится по наименованию (норма не найдена,
    объём плох) или по нормам позиции (единица не сошлась: в этом сообщении наименования нет).
  */
  const reasonOf = (item: BillOfWorkItem): string => {
    const gap = dropGaps.find(
      (candidate) =>
        candidate.message.includes(`«${item.workName}»`) ||
        (item.normCode !== null && candidate.code === item.normCode && candidate.baseType === item.normBaseType),
    );
    return (
      gap?.message.replace(/ — позиция в расчёт не вошла$| — стоимость не рассчитана$/u, "") ??
      "норма не подобрана или её единица не совпадает с единицей позиции"
    );
  };

  const removedItems = desired.removed;
  const removedIds = new Set(removedItems.map((item) => item.id));
  const rejected = remainingRejected(base.rejected, editor.edits);
  const pendingAdds = editor.edits.filter((edit) => (edit.kind === "add" || edit.kind === "restore") && pendingIds.has(edit.id));
  const notIncluded = dropped.length + removedItems.length + rejected.length;

  let number = 0;

  return (
    <section className="space-y-3 rounded-md border border-border/60 p-3" aria-label="Ведомость и нормы" data-testid="bill-table">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Ведомость и нормы</h3>
          <p className="text-xs text-muted-foreground">
            Проверьте, что норма подобрана под ту работу, что в документе, и что объём прочитан верно. Исправленное
            пересчитывается без ИИ.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="review-count">
            <Badge tone={toReview > 0 ? "mustard" : "olive"}>{`Проверить: ${String(toReview)} ${positionsWord(toReview)}`}</Badge>
          </span>
          <Checkbox
            label="показать только требующие проверки"
            checked={onlyReview}
            onChange={(event) => setOnlyReview(event.target.checked)}
          />
        </div>
      </div>

      {editor.conflict !== null && <ConflictBanner editor={editor} />}

      <div className="flex flex-wrap items-center gap-2" data-testid="bill-actions">
        <Button type="button" size="sm" disabled={!editor.dirty || editor.recalculating} loading={editor.recalculating} onClick={() => void editor.recalc()}>
          Пересчитать
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setAdding((value) => !value)}>
          Добавить строку
        </Button>
        {editor.edits.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={editor.resetAll}>
            Сбросить все правки
          </Button>
        )}
        <span className="text-xs text-muted-foreground" data-testid="edits-count">
          {editor.edits.length > 0 ? `${String(editor.edits.length)} ${editsWord(editor.edits.length)}` : "Правок нет"}
          {editor.dirty && editor.edits.length > 0 ? " — ждут пересчёта" : ""}
          {editor.edits.length > 0 && editor.place === "device" ? " · сохранены на этом устройстве" : ""}
        </span>
      </div>

      {editor.error !== null && (
        <p className="text-sm text-brick-fg" role="alert" data-testid="recalc-error">
          {editor.error}
        </p>
      )}
      {editor.notice !== null && <p className="text-sm text-mustard-fg">{editor.notice}</p>}
      {editor.diff !== null && !editor.dirty && (
        <p className="text-sm" data-testid="totals-diff">
          Стоимость СМР: было {rub(editor.diff.before.workCost)} → стало <strong>{rub(editor.diff.after.workCost)}</strong> (
          {signed(editor.diff.after.workCost - editor.diff.before.workCost)}); с НДС: было {rub(editor.diff.before.total)} → стало{" "}
          {rub(editor.diff.after.total)}
        </p>
      )}

      {adding && <AddRowForm editor={editor} onClose={() => setAdding(false)} />}

      {pendingAdds.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="pending-adds">
          {pendingAdds.map((edit) =>
            edit.kind === "add" || edit.kind === "restore" ? (
              <li key={edit.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-accent-subtle/40 px-3 py-1.5">
                <span>
                  {edit.kind === "add" ? "Добавлена" : "Возвращена"}: {edit.row.workName} · {formatNumber(edit.row.quantity)} {edit.row.unit}
                  {edit.row.unitPrice !== null
                    ? ` · своя цена ${formatNumber(edit.row.unitPrice)} ₽`
                    : edit.row.norm !== null
                      ? ` · ${edit.row.norm.baseType} ${edit.row.norm.code}`
                      : ""}{" "}
                  <span className="text-xs text-muted-foreground">— ждёт пересчёта</span>
                </span>
                <Button type="button" size="sm" variant="ghost" onClick={() => editor.drop(edit)}>
                  Убрать
                </Button>
              </li>
            ) : null,
          )}
        </ul>
      )}

      <div role="table" aria-label="Позиции ведомости" className="text-sm">
        <div role="row" className={cn("hidden border-b border-border/60 pb-1 text-xs font-medium text-muted-foreground", GRID)}>
          <span role="columnheader">№</span>
          <span role="columnheader">Работа и цитата из документа</span>
          <span role="columnheader">Объём</span>
          <span role="columnheader">Норма</span>
          <span role="columnheader">Источник цены</span>
          <span role="columnheader" className="text-right">
            Стоимость
          </span>
          <span role="columnheader" />
        </div>

        {sections.map((section) => {
          // Удалённая человеком строка уходит в «Не вошло в расчёт» сразу, хотя итог обновится после пересчёта.
          const items = section.items.filter((item) => lines.has(item.id) && !removedIds.has(item.id));
          const visible = onlyReview
            ? items.filter((item) => matchBadge(rows.get(item.id), lines.get(item.id)).review)
            : items;
          if (visible.length === 0) return null;
          return (
            <div key={section.title} role="rowgroup">
              <p className="mt-3 break-words bg-panel-raised/60 px-2 py-1 text-xs font-medium text-muted-foreground">{section.title}</p>
              {visible.map((item) => {
                number += 1;
                const line = lines.get(item.id);
                if (line === undefined) return null;
                const info = rows.get(item.id);
                const badge = matchBadge(info, line);
                const generated = generatedBadge(item);
                const edited = marks.get(item.id);
                const pending = pendingIds.has(item.id);
                const desiredItem = desiredItems.get(item.id) ?? item;
                const open = openId === item.id;
                return (
                  <div
                    key={item.id}
                    role="row"
                    data-testid={`bill-row-${item.id}`}
                    data-review={badge.review ? "true" : "false"}
                    className={cn(
                      "border-b border-border/60 px-2 py-2",
                      GRID,
                      badge.review && "border-l-2 border-l-mustard-line bg-mustard-subtle/30",
                    )}
                  >
                    <span role="cell" className="hidden text-xs text-muted-foreground md:block">
                      {number}
                    </span>

                    <div role="cell" className="min-w-0">
                      <p className="break-words font-medium">
                        <span className="mr-1 text-xs font-normal text-muted-foreground md:hidden">{number}.</span>
                        {item.workName}
                      </p>
                      {item.sourceQuote !== null && item.sourceQuote !== "" && <Quote quote={item.sourceQuote} document={item.sourceDocument} />}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {generated !== null && (
                          <span data-testid="generated-badge">
                            <Badge tone={generated.tone}>{generated.text}</Badge>
                          </span>
                        )}
                        {edited !== undefined && <Badge tone="accent" dot={false}>изменено</Badge>}
                        {pending && <Badge tone="mustard" dot={false}>правка ждёт пересчёта</Badge>}
                      </div>
                      {generated !== null && (
                        <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="generated-note">
                          {generated.note === null ? "Строка добавлена сверх ведомости." : `${generated.note}.`} Не нужна — «Изменить» → «Удалить строку»; отключить такие строки целиком можно в «Условиях работ» перед расчётом.
                        </p>
                      )}
                      {edited !== undefined && (
                        <p className="mt-1 text-xs text-muted-foreground">{edited.notes.join("; ")}</p>
                      )}
                    </div>

                    <p role="cell" className="num mt-1 md:mt-0">
                      <span className="text-xs text-muted-foreground md:hidden">Объём: </span>
                      {formatNumber(line.billQuantity)} {line.billUnit}
                    </p>

                    <div role="cell" className="min-w-0">
                      <NormCell line={line} badge={badge} info={info} />
                    </div>

                    <p role="cell" className="mt-1 md:mt-0">
                      <span className="text-xs text-muted-foreground md:hidden">Цена: </span>
                      {priceSourceLabel(line)}
                    </p>

                    <p role="cell" className="num font-medium md:text-right">
                      <span className="text-xs font-normal text-muted-foreground md:hidden">Стоимость: </span>
                      {formatNumber(Math.round(lineTotal(line)))} ₽
                    </p>

                    <div role="cell" className="mt-2 md:mt-0 md:text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-expanded={open}
                        onClick={() => setOpenId(open ? null : item.id)}
                      >
                        {open ? "Закрыть" : "Изменить"}
                      </Button>
                    </div>

                    {open && (
                      <div className="mt-2 md:col-span-7">
                        <RowEditor
                          editor={editor}
                          item={desiredItem}
                          anchorItem={baseItems.get(item.id) ?? desiredItem}
                          info={info}
                          line={line}
                          isOwnRow={ownIds.has(item.id)}
                          onClose={() => setOpenId(null)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {shownLines.length === 0 && <p className="text-sm text-muted-foreground">В расчёт не вошла ни одна позиция.</p>}
      {onlyReview && toReview === 0 && shownLines.length > 0 && (
        <p className="text-sm text-muted-foreground">Позиций, требующих проверки, нет.</p>
      )}

      {notIncluded > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2" data-testid="not-included">
          <summary className="cursor-pointer text-sm font-medium">{`Не вошло в расчёт: ${String(notIncluded)}`}</summary>
          <ul className="mt-2 space-y-2">
            {removedItems.map((item) => (
              <li key={`removed-${item.id}`} className="space-y-1 rounded-md bg-panel-raised/60 px-3 py-2 text-sm" data-testid={`removed-${item.id}`}>
                <p className="break-words font-medium">{item.workName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(item.quantity)} {item.quantityUnit} · вы удалили эту строку
                  {pendingIds.has(item.id) ? " — итог обновится после пересчёта" : ""}
                </p>
                <Button type="button" size="sm" variant="secondary" onClick={() => editor.clear(item.id, "remove")}>
                  Вернуть в расчёт
                </Button>
              </li>
            ))}

            {dropped.map((item) => (
              <li key={`dropped-${item.id}`} className="space-y-1 rounded-md bg-mustard-subtle/40 px-3 py-2 text-sm" data-testid={`dropped-${item.id}`}>
                <p className="break-words font-medium">{item.workName}</p>
                <p className="text-xs text-mustard-fg">
                  {formatNumber(item.quantity)} {item.quantityUnit} · {reasonOf(item)}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setOpenId(openId === `dropped-${item.id}` ? null : `dropped-${item.id}`)}
                >
                  Вернуть в расчёт
                </Button>
                {openId === `dropped-${item.id}` && (
                  <div className="mt-2">
                    <RowEditor
                      editor={editor}
                      item={desiredItems.get(item.id) ?? item}
                      anchorItem={baseItems.get(item.id) ?? item}
                      info={rows.get(item.id)}
                      isOwnRow={ownIds.has(item.id)}
                      onClose={() => setOpenId(null)}
                    />
                  </div>
                )}
              </li>
            ))}

            {rejected.map((item, index) => (
              <RejectedRow key={`rejected-${String(index)}-${item.row.workName}`} item={item} editor={editor} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Цитата из документа: одна строка, по клику — полностью, с именем файла. */
function Quote({ quote, document }: { readonly quote: string; readonly document: string | null }) {
  const short = quote.length > 90 ? `${quote.slice(0, 90).trimEnd()}…` : quote;
  return (
    <details className="mt-0.5 text-xs text-muted-foreground" data-testid="quote">
      <summary className="cursor-pointer break-words">Цитата: «{short}»</summary>
      <p className="mt-1 break-words" data-testid="quote-full">
        «{quote}»{document !== null && document !== "" && <span className="mt-0.5 block">Файл: {document}</span>}
      </p>
    </details>
  );
}

function NormCell({
  line,
  badge,
  info,
}: {
  readonly line: EstimateLine;
  readonly badge: ReturnType<typeof matchBadge>;
  readonly info?: BillRowInfo;
}) {
  // Материалы «по проекту» без количества и цены: подсветка отдельно от «проверьте» подбора нормы.
  const pending = (info?.projectMaterials ?? []).filter((material) => !material.supplied);
  const hasNorm = line.priceSource === undefined;
  return (
    <>
      {hasNorm ? (
        <>
          <p className="break-words font-medium">
            {line.normBaseType} {line.normCode}
          </p>
          <p className="line-clamp-2 break-words text-xs text-muted-foreground" title={line.normName}>
            {line.normName}
          </p>
          <p className="text-xs text-muted-foreground">ед. нормы: {line.normUnit}</p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{line.priceNote ?? "Нормы нет: стоимость взята из другого источника"}</p>
      )}
      <span className="mt-1 inline-block" data-testid="match-badge">
        <Badge tone={badge.tone} dot={false} className="whitespace-normal">
          {badge.text}
        </Badge>
      </span>
      {badge.note !== undefined && (
        <p className="mt-0.5 break-words text-xs text-mustard-fg" data-testid="match-note">
          {badge.note}
        </p>
      )}
      {pending.map((material) => (
        <p key={material.code} className="mt-0.5 break-words text-xs text-mustard-fg" data-testid="project-material-note">
          материал по проекту: {material.name} —{" "}
          {material.suggestion === "ASSUMED"
            ? `укажите количество (предложено ${String(material.suggestedQuantity)} ${material.unit}, проверьте) и цену`
            : "укажите количество и цену"}
        </p>
      ))}
    </>
  );
}

/** Отклонённая строка: причина, объём и единица (читаются или правятся) и «Вернуть в расчёт». */
function RejectedRow({ item, editor }: { readonly item: RejectedBillRow; readonly editor: BillEditor }) {
  const parsed = parseRejectedVolume(item.row);
  const [quantityText, setQuantityText] = useState(parsed.quantity === null ? String(item.row.quantity) : String(parsed.quantity).replace(".", ","));
  const [unit, setUnit] = useState(parsed.unit ?? "");

  const quantity = parseDecimal(quantityText);
  const edit: BillEdit | null = quantity === null || unit === "" ? null : restoreEdit(item, { quantity, unit });

  return (
    <li className="space-y-1 rounded-md bg-panel-raised/60 px-3 py-2 text-sm" data-testid="rejected-row">
      <p className="break-words font-medium">{item.row.workName}</p>
      <p className="break-words text-xs text-muted-foreground">
        {REASON_LABELS[item.reason] ?? item.reason}. {item.message}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block w-28">
          <span className="label">Объём</span>
          <Input inputMode="decimal" value={quantityText} onChange={(event) => setQuantityText(event.target.value)} aria-label="Объём возвращаемой строки" />
        </label>
        <label className="block w-28">
          <span className="label">Единица</span>
          <UnitSelect value={unit} onChange={setUnit} label="Единица возвращаемой строки" />
        </label>
        <Button type="button" size="sm" variant="secondary" disabled={edit === null} onClick={() => edit !== null && editor.record(edit)}>
          Вернуть в расчёт
        </Button>
      </div>
      {edit === null && <p className="text-xs text-mustard-fg">Чтобы вернуть строку, укажите объём числом и единицу из списка.</p>}
    </li>
  );
}

/** Правки к прошлой ведомости: применить или отбросить. */
function ConflictBanner({ editor }: { readonly editor: BillEditor }) {
  const conflict = editor.conflict;
  if (conflict === null) return null;
  const total = conflict.record.edits.length;
  const found = conflict.remapped.edits.length;
  return (
    <div className="space-y-2 rounded-md border border-mustard-line bg-mustard-subtle px-3 py-2" data-testid="edits-conflict">
      <p className="text-sm font-medium text-mustard-fg">Есть ваши правки к прошлой ведомости</p>
      <p className="text-sm text-mustard-fg">
        Ведомость при новом расчёте изменилась. Правок: {total}. Найдут свою строку в новой ведомости: {found}
        {conflict.remapped.unmatched.length > 0 ? `; не найдут: ${String(conflict.remapped.unmatched.length)}` : ""}
        {conflict.remapped.alreadyPresent.length > 0 ? `; уже есть в новой ведомости: ${String(conflict.remapped.alreadyPresent.length)}` : ""}.
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void editor.applyConflict()}>
          Применить
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={editor.discardConflict}>
          Отбросить
        </Button>
      </div>
    </div>
  );
}
