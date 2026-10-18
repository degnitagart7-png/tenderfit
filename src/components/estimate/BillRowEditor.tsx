"use client";

import { useState } from "react";

import { NormPicker } from "@/components/estimate/NormPicker";
import { Button, Input, Select } from "@/components/ui/primitives";
import {
  anchorOf,
  nextAddedId,
  validateAddedRow,
  type AddedRow,
  type NormPick,
} from "@/domain/estimate/billEdits";
import type { BillRowInfo } from "@/domain/estimate/billReview";
import { hasConfirmedConditions } from "@/domain/estimate/customerCoefficients";
import type { BillOfWorkItem, EstimateLine } from "@/domain/estimate/types";
import { SUPPORTED_UNITS } from "@/domain/estimate/units";
import type { BillEditor } from "@/hooks/useBillEdits";

/**
 * Правка строки ведомости: объём и единица, норма или своя цена, удаление.
 *
 * Раскрывается под самой строкой, а не в боковой панели: таблица уже занимает всю ширину карточки,
 * а панель сбоку на 1280 px закрыла бы либо её, либо норму, которую правят, и на телефоне вела бы
 * себя иначе. Строка-раскрывашка одинаково работает на любой ширине и не уводит взгляд от позиции.
 *
 * «Применить правку» только кладёт правку в список; на итог она влияет после «Пересчитать».
 */

/** «1 200,5» и «1200.5» → 1200.5; не число или не больше нуля — null. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.replace(/[\s ]/gu, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/u.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const toText = (value: number): string => String(value).replace(".", ",");

export function UnitSelect({
  value,
  onChange,
  label = "Единица",
}: {
  readonly value: string;
  readonly onChange: (unit: string) => void;
  readonly label?: string;
}) {
  const units = SUPPORTED_UNITS.includes(value) || value === "" ? SUPPORTED_UNITS : [value, ...SUPPORTED_UNITS];
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
      {value === "" && <option value="">—</option>}
      {units.map((unit) => (
        <option key={unit} value={unit}>
          {unit}
        </option>
      ))}
    </Select>
  );
}

type PickState = NormPick | "auto";

const samePick = (left: PickState, right: PickState): boolean =>
  left !== "auto" && right !== "auto" ? left.code === right.code && left.baseType === right.baseType : left === right;

export function RowEditor({
  editor,
  item,
  anchorItem,
  info,
  line,
  isOwnRow,
  onClose,
}: {
  readonly editor: BillEditor;
  /** Строка с уже внесёнными, но не применёнными правками. */
  readonly item: BillOfWorkItem;
  /** Строка исходной ведомости: от неё считаются «якорь» правки и «что изменено». */
  readonly anchorItem: BillOfWorkItem;
  readonly info?: BillRowInfo;
  readonly line?: EstimateLine;
  /** Строка добавлена или возвращена человеком: исходного состояния у неё нет. */
  readonly isOwnRow: boolean;
  readonly onClose: () => void;
}) {
  const hasNormEdit = editor.edits.some((edit) => edit.kind === "norm" && edit.anchor.itemId === item.id);
  const ownNorm = isOwnRow && item.normCode !== null && item.normBaseType !== null;
  const manualPick: NormPick | null =
    (hasNormEdit || ownNorm) && item.normCode !== null && item.normBaseType !== null
      ? { code: item.normCode, baseType: item.normBaseType }
      : null;

  const [quantityText, setQuantityText] = useState(toText(item.quantity));
  const [unit, setUnit] = useState(item.quantityUnit);
  const [mode, setMode] = useState<"norm" | "price">((item.ownUnitPrice ?? 0) > 0 ? "price" : "norm");
  const [priceText, setPriceText] = useState(item.ownUnitPrice != null && item.ownUnitPrice > 0 ? toText(item.ownUnitPrice) : "");
  const [pick, setPick] = useState<PickState>(manualPick ?? "auto");
  const [searched, setSearched] = useState<{ pick: NormPick; label: string; unit: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /*
    Коэффициенты заказчика (ЛСР): строка несёт их подтверждённую приложением 10 часть и отклонённую. Галочка
    показывает, применяются ли они сейчас. Без правки подтверждённые применяются (если не сняты общим
    переключателем), неподтверждённые — нет; правка записывается, только если выбор расходится с этим.
  */
  const conditions = anchorItem.customerConditions;
  const appliedByDefault = conditions !== undefined && conditions.enabled && hasConfirmedConditions(conditions);
  const shownConditions = item.customerConditions ?? conditions;
  const [coefficientsOn, setCoefficientsOn] = useState<boolean>(
    shownConditions !== undefined && shownConditions.enabled && (hasConfirmedConditions(shownConditions) || shownConditions.forceUnconfirmed),
  );

  /*
    Материалы «по проекту»: у норм с расходом «П» или материалом без марки в расчёт не входит их стоимость, пока не названы
    количество и цена. Количество подставляется предложенное (по норме или 1 на единицу позиции) — его видно и правится.
  */
  const hints = isOwnRow ? [] : (info?.projectMaterials ?? []);
  const [materialTexts, setMaterialTexts] = useState<Record<string, { quantity: string; price: string }>>(() =>
    Object.fromEntries(
      hints.map((hint) => {
        const given = (item.projectMaterials ?? []).find((material) => material.code === hint.code);
        return [
          hint.code,
          {
            quantity: given !== undefined ? toText(given.quantity) : hint.suggestedQuantity !== null ? toText(hint.suggestedQuantity) : "",
            price: given !== undefined ? toText(given.unitPrice) : "",
          },
        ];
      }),
    ),
  );

  // Нормы на выбор: подобранная расчётом (если выбор не ручной), альтернативы подбора и найденная поиском.
  const options: { key: string; pick: PickState; title: string; sub: string; warn: boolean }[] = [];
  if (!isOwnRow) {
    const autoNorm =
      line !== undefined && line.priceSource === undefined && !hasNormEdit
        ? `${line.normBaseType} ${line.normCode} · ${line.normName}`
        : "подбор по наименованию";
    options.push({
      key: "auto",
      pick: "auto",
      title: hasNormEdit ? "Подобрать автоматически, как было" : `Подобрано расчётом: ${autoNorm}`,
      sub: "",
      warn: false,
    });
  }
  for (const candidate of info?.alternatives ?? []) {
    options.push({
      key: `${candidate.baseType}|${candidate.code}`,
      pick: { code: candidate.code, baseType: candidate.baseType },
      title: `${candidate.baseType} ${candidate.code} · ${candidate.name}`,
      sub: `ед. нормы: ${candidate.unit} · совпадение слов ${String(Math.round(candidate.coverage * 100))} %`,
      warn: !candidate.unitOk,
    });
  }
  const extra = [
    ...(searched === null ? [] : [{ pick: searched.pick, title: searched.label, unit: searched.unit }]),
    ...(manualPick !== null ? [{ pick: manualPick, title: `${manualPick.baseType} ${manualPick.code}`, unit: "" }] : []),
  ];
  for (const item2 of extra) {
    if (options.some((option) => samePick(option.pick, item2.pick))) continue;
    options.push({
      key: `${item2.pick.baseType}|${item2.pick.code}`,
      pick: item2.pick,
      title: item2.title,
      sub: item2.unit === "" ? "" : `ед. нормы: ${item2.unit}`,
      warn: false,
    });
  }

  const apply = (): void => {
    const quantity = parseDecimal(quantityText);
    if (quantity === null) return setProblem("Объём должен быть числом больше нуля");
    if (unit === "") return setProblem("Выберите единицу");
    const anchor = anchorOf(isOwnRow ? item : anchorItem);

    if (mode === "price") {
      const price = parseDecimal(priceText);
      if (price === null) return setProblem("Цена за единицу должна быть числом больше нуля");
      editor.record({ kind: "price", anchor, unitPrice: price });
    } else {
      if (isOwnRow && pick === "auto") return setProblem("Выберите норму или укажите свою цену");
      editor.clear(item.id, "price");
      if (pick === "auto") editor.clear(item.id, "norm");
      else editor.record({ kind: "norm", anchor, norm: pick });
    }

    editor.record({
      kind: "change",
      anchor,
      ...(isOwnRow || quantity !== anchor.quantity ? { quantity } : {}),
      ...(isOwnRow || unit !== anchor.unit ? { unit } : {}),
    });
    if (mode === "norm") {
      for (const hint of hints) {
        const text = materialTexts[hint.code] ?? { quantity: "", price: "" };
        if (text.price.trim() === "") {
          editor.clear(item.id, "material", hint.code);
          continue;
        }
        const materialQuantity = parseDecimal(text.quantity);
        const materialPrice = parseDecimal(text.price);
        if (materialQuantity === null || materialPrice === null) {
          return setProblem(`Материал «${hint.name}»: количество и цена за единицу должны быть числами больше нуля`);
        }
        editor.record({ kind: "material", anchor, code: hint.code, name: hint.name, unit: hint.unit, quantity: materialQuantity, unitPrice: materialPrice });
      }
    }
    if (conditions !== undefined && !isOwnRow) {
      if (coefficientsOn === appliedByDefault) editor.clear(item.id, "coefficients");
      else editor.record({ kind: "coefficients", anchor, apply: coefficientsOn });
    }
    setProblem(null);
    onClose();
  };

  const remove = (): void => {
    editor.record({ kind: "remove", anchor: anchorOf(isOwnRow ? item : anchorItem) });
    onClose();
  };

  return (
    <div className="space-y-3 rounded-md border border-accent-line bg-accent-subtle/30 p-3" data-testid={`row-editor-${item.id}`}>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <label className="block">
          <span className="label">Объём</span>
          <Input
            inputMode="decimal"
            value={quantityText}
            onChange={(event) => setQuantityText(event.target.value)}
            aria-label="Объём"
          />
        </label>
        <label className="block">
          <span className="label">Единица</span>
          <UnitSelect value={unit} onChange={setUnit} />
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Как считать</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="radio" name={`mode-${item.id}`} checked={mode === "norm"} onChange={() => setMode("norm")} />
            По норме
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name={`mode-${item.id}`} checked={mode === "price"} onChange={() => setMode("price")} />
            По своей цене
          </label>
        </div>
      </fieldset>

      {mode === "norm" ? (
        <div className="space-y-2">
          {options.length > 0 && (
            <ul className="space-y-1" data-testid="norm-options">
              {options.map((option) => (
                <li key={option.key}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 bg-panel px-3 py-2 text-sm">
                    <input
                      type="radio"
                      name={`norm-${item.id}`}
                      className="mt-1"
                      checked={samePick(option.pick, pick)}
                      onChange={() => setPick(option.pick)}
                    />
                    <span className="min-w-0">
                      <span className="block break-words">{option.title}</span>
                      {option.sub !== "" && <span className="block text-xs text-muted-foreground">{option.sub}</span>}
                      {option.warn && (
                        <span className="block text-xs text-mustard-fg">
                          Единица нормы не совпадает с единицей позиции — позиция не войдёт в расчёт
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs font-medium text-muted-foreground">
            {editor.effective.document.method === "BASE_INDEX" ? "Не нашли нужную? Найдите расценку ФЕР по шифру или словам" : "Не нашли нужную? Найдите норму по шифру или словам"}
          </p>
          <NormPicker
            unit={unit}
            method={editor.effective.document.method}
            onPick={(norm, hit) => {
              setSearched({ pick: norm, label: `${hit.baseType} ${hit.code} · ${hit.name}`, unit: hit.unit });
              setPick(norm);
            }}
          />
        </div>
      ) : (
        <label className="block">
          <span className="label">Своя цена за единицу, ₽ без НДС</span>
          <Input
            inputMode="decimal"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            aria-label="Своя цена за единицу"
          />
          <span className="muted mt-1 block text-xs">
            Стоимость позиции = объём × цена. Накладные расходы и сметная прибыль не начисляются: цена считается готовой.
          </span>
        </label>
      )}

      {mode === "norm" && hints.length > 0 && (
        <fieldset className="space-y-2 rounded-md border border-mustard-line bg-mustard-subtle/30 px-3 py-2 text-sm" data-testid="project-materials">
          <legend className="label">Материалы по проекту</legend>
          <p className="text-xs text-mustard-fg">
            В норме эти материалы указаны «по проекту»: их количества и цены нет, и без них стоимость позиции занижена. Укажите цену за
            единицу, чтобы материал вошёл в расчёт.
          </p>
          {hints.map((hint) => {
            const text = materialTexts[hint.code] ?? { quantity: "", price: "" };
            const set = (patch: Partial<{ quantity: string; price: string }>): void =>
              setMaterialTexts((current) => ({ ...current, [hint.code]: { ...text, ...patch } }));
            return (
              <div key={hint.code} className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem]" data-testid={`project-material-${hint.code}`}>
                <span className="min-w-0 break-words">
                  {hint.name}
                  <span className="block text-xs text-muted-foreground">
                    {hint.suggestion === "NORM"
                      ? `количество по норме, ${hint.unit}`
                      : hint.suggestion === "ASSUMED"
                        ? `расход по проекту: предложено 1 ${hint.unit} на ${hint.unit} позиции — предложено, проверьте`
                        : `расход по проекту, ${hint.unit} — укажите количество`}
                  </span>
                </span>
                <label className="block">
                  <span className="label">Количество, {hint.unit}</span>
                  <Input inputMode="decimal" value={text.quantity} onChange={(event) => set({ quantity: event.target.value })} aria-label={`Количество: ${hint.name}`} />
                </label>
                <label className="block">
                  <span className="label">Цена за {hint.unit}, ₽</span>
                  <Input inputMode="decimal" value={text.price} onChange={(event) => set({ price: event.target.value })} aria-label={`Цена: ${hint.name}`} />
                </label>
              </div>
            );
          })}
        </fieldset>
      )}

      {conditions !== undefined && !isOwnRow && (
        <fieldset className="space-y-1 rounded-md border border-border/60 bg-panel px-3 py-2 text-sm" data-testid="customer-coefficients">
          <label className="inline-flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={coefficientsOn}
              onChange={(event) => setCoefficientsOn(event.target.checked)}
              aria-label="Коэффициент заказчика"
            />
            <span>
              Коэффициент заказчика
              {hasConfirmedConditions(conditions) ? (
                <span className="block text-xs text-muted-foreground">{conditions.label}</span>
              ) : (
                <span className="block text-xs text-mustard-fg">
                  Приложением 10 не подтверждён: если включить, значения заказчика применятся как допущение
                </span>
              )}
            </span>
          </label>
          {conditions.rejected.map((claim) => (
            <p key={claim.text} className="text-xs text-mustard-fg">
              Не подтверждено приложением 10: {claim.text.slice(0, 140)} — {claim.reason.split(". По приложению")[0]}
            </p>
          ))}
        </fieldset>
      )}

      {problem !== null && (
        <p className="text-sm text-brick-fg" role="alert">
          {problem}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={apply}>
          Применить правку
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          Отмена
        </Button>
        <Button type="button" size="sm" variant="danger" onClick={remove}>
          Удалить строку
        </Button>
      </div>
    </div>
  );
}

/** Добавление строки: наименование, объём, единица и норма (поиском) или своя цена. */
export function AddRowForm({ editor, onClose }: { readonly editor: BillEditor; readonly onClose: () => void }) {
  const [name, setName] = useState("");
  const [quantityText, setQuantityText] = useState("");
  const [unit, setUnit] = useState("м2");
  const [mode, setMode] = useState<"norm" | "price">("norm");
  const [norm, setNorm] = useState<{ pick: NormPick; label: string } | null>(null);
  const [priceText, setPriceText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    const row: AddedRow = {
      workName: name.trim(),
      quantity: parseDecimal(quantityText) ?? 0,
      unit,
      norm: mode === "norm" && norm !== null ? norm.pick : null,
      unitPrice: mode === "price" ? parseDecimal(priceText) : null,
      sourceQuote: null,
      sourceDocument: null,
    };
    const invalid = validateAddedRow(row);
    if (invalid !== null) return setProblem(invalid);
    editor.record({ kind: "add", id: nextAddedId(editor.edits), row });
    onClose();
  };

  return (
    <div className="space-y-3 rounded-md border border-accent-line bg-accent-subtle/30 p-3" data-testid="add-row-form">
      <p className="text-sm font-medium">Добавить строку в ведомость</p>
      <label className="block">
        <span className="label">Наименование работы</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Наименование работы" />
      </label>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <label className="block">
          <span className="label">Объём</span>
          <Input
            inputMode="decimal"
            value={quantityText}
            onChange={(event) => setQuantityText(event.target.value)}
            aria-label="Объём новой строки"
          />
        </label>
        <label className="block">
          <span className="label">Единица</span>
          <UnitSelect value={unit} onChange={setUnit} label="Единица новой строки" />
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="add-mode" checked={mode === "norm"} onChange={() => setMode("norm")} />
          Норма из базы
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="add-mode" checked={mode === "price"} onChange={() => setMode("price")} />
          Своя цена
        </label>
      </div>
      {mode === "norm" ? (
        <div className="space-y-2">
          {norm !== null && <p className="text-sm">Выбрано: {norm.label}</p>}
          <NormPicker unit={unit} method={editor.effective.document.method} onPick={(pick, hit) => setNorm({ pick, label: `${hit.baseType} ${hit.code} · ${hit.name}` })} />
        </div>
      ) : (
        <label className="block">
          <span className="label">Своя цена за единицу, ₽ без НДС</span>
          <Input
            inputMode="decimal"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            aria-label="Своя цена новой строки"
          />
        </label>
      )}
      {problem !== null && (
        <p className="text-sm text-brick-fg" role="alert">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit}>
          Добавить
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </div>
  );
}
