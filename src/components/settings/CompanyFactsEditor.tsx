"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";

import type { CompanyFacts } from "@/domain/companyFacts/types";
import { Input, Select } from "@/components/ui/primitives";

/**
 * Редактируемая сводка фактов о компании: человек видит, что система поняла из документов, и может удалить или поправить
 * строку до того, как сверка с закупками начнёт на них опираться. Правки идут в анкету тем же сохранением, что и остальное.
 *
 * Группы без записей не показываются. Длинные списки (контракты, прайс) — под раскрывающимся заголовком: нужны не всегда.
 */

const MAX_ROWS_SHOWN = 60;

const SRO_KINDS = [
  { value: "CONSTRUCTION", label: "Строительство" },
  { value: "DESIGN", label: "Проектирование" },
  { value: "SURVEY", label: "Изыскания" },
  { value: "OTHER", label: "Иное" },
] as const;

const LAW_LABELS: Record<string, string> = { "44-FZ": "44-ФЗ", "223-FZ": "223-ФЗ", commercial: "коммерческий", unknown: "закон не указан" };

function toNumberOrNull(text: string): number | null {
  const cleaned = text.replace(/[\s ]/gu, "").replace(",", ".");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function NumberInput({
  value,
  onChange,
  label,
  className,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  className?: string;
}) {
  return (
    <Input
      inputMode="decimal"
      aria-label={label}
      title={label}
      placeholder={label}
      className={className}
      defaultValue={value === null ? "" : String(value)}
      key={String(value)}
      onBlur={(event) => {
        const next = toNumberOrNull(event.target.value);
        if (next !== value) onChange(next);
      }}
    />
  );
}

function TextInput({ value, onChange, label, className }: { value: string; onChange: (value: string) => void; label: string; className?: string }) {
  return (
    <Input
      aria-label={label}
      title={label}
      placeholder={label}
      className={className}
      defaultValue={value}
      key={value}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== value && next !== "") onChange(next);
      }}
    />
  );
}

function RemoveButton({ onClick, what }: { onClick: () => void; what: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-panel-raised hover:text-foreground"
      aria-label={`Удалить: ${what}`}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

function Group({ title, count, note, children, defaultOpen = false }: { title: string; count: number; note?: string; children: ReactNode; defaultOpen?: boolean }) {
  if (count === 0) return null;
  return (
    <details className="group border-t border-border py-3" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 text-[14.5px] font-medium text-foreground">
        <span>
          {title} <span className="font-normal text-muted-foreground">· {count}</span>
        </span>
        <span className="text-xs font-normal text-faint group-open:hidden">показать</span>
        <span className="hidden text-xs font-normal text-faint group-open:inline">скрыть</span>
      </summary>
      {note !== undefined && <p className="muted mt-1">{note}</p>}
      <div className="mt-3 space-y-2">{children}</div>
    </details>
  );
}

function Row({ children, onRemove, what }: { children: ReactNode; onRemove: () => void; what: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-6">{children}</div>
      <RemoveButton onClick={onRemove} what={what} />
    </div>
  );
}

function overflowNote(total: number): ReactNode {
  return total > MAX_ROWS_SHOWN ? <p className="muted">Показаны первые {MAX_ROWS_SHOWN} из {total}: остальные тоже учитываются.</p> : null;
}

export function CompanyFactsEditor({ facts, onChange }: { facts: CompanyFacts; onChange: (facts: CompanyFacts) => void }) {
  const update = (patch: Partial<CompanyFacts>) => onChange({ ...facts, ...patch });
  const replaceAt = <T,>(list: T[], index: number, patch: Partial<T>): T[] => list.map((item, i) => (i === index ? { ...item, ...patch } : item));
  const removeAt = <T,>(list: T[], index: number): T[] => list.filter((_, i) => i !== index);

  return (
    <div data-testid="company-facts-editor" className="border-b border-border">
      <Group title="Виды работ" count={facts.workTypes.length} defaultOpen>
        {facts.workTypes.slice(0, MAX_ROWS_SHOWN).map((item, index) => (
          <Row key={`${item.name}-${String(index)}`} what={item.name} onRemove={() => update({ workTypes: removeAt(facts.workTypes, index) })}>
            <TextInput label="Вид работ" className="col-span-2 sm:col-span-3" value={item.name} onChange={(name) => update({ workTypes: replaceAt(facts.workTypes, index, { name }) })} />
            <NumberInput label="Контрактов" value={item.contractsCount} onChange={(contractsCount) => update({ workTypes: replaceAt(facts.workTypes, index, { contractsCount }) })} />
            <NumberInput label="Сумма, ₽" className="col-span-2" value={item.totalSumRub} onChange={(totalSumRub) => update({ workTypes: replaceAt(facts.workTypes, index, { totalSumRub }) })} />
          </Row>
        ))}
        {overflowNote(facts.workTypes.length)}
      </Group>

      <Group title="Контракты" count={facts.contracts.length} note="Исполненные контракты из документов: по ним сверяется опыт.">
        {facts.contracts.slice(0, MAX_ROWS_SHOWN).map((item, index) => (
          <Row key={item.id} what={item.subject} onRemove={() => update({ contracts: removeAt(facts.contracts, index) })}>
            <TextInput label="Предмет" className="col-span-2 sm:col-span-3" value={item.subject} onChange={(subject) => update({ contracts: replaceAt(facts.contracts, index, { subject }) })} />
            <NumberInput label="Год" value={item.year} onChange={(year) => update({ contracts: replaceAt(facts.contracts, index, { year: year === null ? null : Math.round(year) }) })} />
            <NumberInput label="Сумма, ₽" value={item.sumRub} onChange={(sumRub) => update({ contracts: replaceAt(facts.contracts, index, { sumRub }) })} />
            <span className="self-center truncate text-[12.5px] text-muted-foreground" title={item.customer ?? undefined}>
              {LAW_LABELS[item.law] ?? item.law}
            </span>
          </Row>
        ))}
        {overflowNote(facts.contracts.length)}
      </Group>

      <Group title="СРО" count={facts.sro.length} defaultOpen>
        {facts.sro.map((item, index) => (
          <Row key={item.id} what={`СРО ${String(index + 1)}`} onRemove={() => update({ sro: removeAt(facts.sro, index) })}>
            <Select
              aria-label="Вид допуска"
              className="col-span-2"
              value={item.kind}
              onChange={(event) => update({ sro: replaceAt(facts.sro, index, { kind: event.target.value as (typeof SRO_KINDS)[number]["value"] }) })}
            >
              {SRO_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
            <NumberInput label="Уровень (1–5)" value={item.level} onChange={(level) => update({ sro: replaceAt(facts.sro, index, { level: level === null ? null : Math.min(5, Math.max(1, Math.round(level))) }) })} />
            <NumberInput label="Предел договора, ₽" className="col-span-2" value={item.maxContractRub} onChange={(maxContractRub) => update({ sro: replaceAt(facts.sro, index, { maxContractRub }) })} />
          </Row>
        ))}
      </Group>

      <Group title="Лицензии" count={facts.licenses.length} defaultOpen>
        {facts.licenses.map((item, index) => (
          <Row key={item.id} what={item.kind} onRemove={() => update({ licenses: removeAt(facts.licenses, index) })}>
            <TextInput label="Лицензия" className="col-span-2 sm:col-span-4" value={item.kind} onChange={(kind) => update({ licenses: replaceAt(facts.licenses, index, { kind }) })} />
            <span className="col-span-2 self-center truncate text-[12.5px] text-muted-foreground">{item.issuer ?? ""}</span>
          </Row>
        ))}
      </Group>

      <Group title="Кадры" count={facts.staff.length + (facts.staffTotal ? 1 : 0)}>
        {facts.staffTotal ? (
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] text-muted-foreground">Штат всего, чел.</span>
            <NumberInput label="Штат всего" className="w-28" value={facts.staffTotal} onChange={(total) => update({ staffTotal: total === null ? null : Math.max(1, Math.round(total)) })} />
          </div>
        ) : null}
        {facts.staff.map((item, index) => (
          <Row key={`${item.role}-${String(index)}`} what={item.role} onRemove={() => update({ staff: removeAt(facts.staff, index) })}>
            <TextInput label="Должность" className="col-span-2 sm:col-span-3" value={item.role} onChange={(role) => update({ staff: replaceAt(facts.staff, index, { role }) })} />
            <NumberInput label="Человек" value={item.count} onChange={(count) => update({ staff: replaceAt(facts.staff, index, { count: count === null ? item.count : Math.max(1, Math.round(count)) }) })} />
            <span className="col-span-2 self-center truncate text-[12.5px] text-muted-foreground sm:col-span-2">{item.qualification ?? ""}</span>
          </Row>
        ))}
      </Group>

      <Group title="Техника" count={facts.equipment.length}>
        {facts.equipment.map((item, index) => (
          <Row key={`${item.name}-${String(index)}`} what={item.name} onRemove={() => update({ equipment: removeAt(facts.equipment, index) })}>
            <TextInput label="Техника" className="col-span-2 sm:col-span-4" value={item.name} onChange={(name) => update({ equipment: replaceAt(facts.equipment, index, { name }) })} />
            <NumberInput label="Шт." value={item.count} onChange={(count) => update({ equipment: replaceAt(facts.equipment, index, { count: count === null ? null : Math.round(count) }) })} />
          </Row>
        ))}
      </Group>

      <Group
        title="Свои цены"
        count={facts.prices.length}
        note="Цены из вашего прайс-листа. Позже по ним можно будет считать участие в закупках по вашим, а не справочным ценам."
      >
        {facts.prices.slice(0, MAX_ROWS_SHOWN).map((item, index) => (
          <Row key={item.id} what={item.name} onRemove={() => update({ prices: removeAt(facts.prices, index) })}>
            <TextInput label="Позиция" className="col-span-2 sm:col-span-3" value={item.name} onChange={(name) => update({ prices: replaceAt(facts.prices, index, { name }) })} />
            <TextInput label="Ед." value={item.unit} onChange={(unit) => update({ prices: replaceAt(facts.prices, index, { unit }) })} />
            <NumberInput label="Цена, ₽" className="col-span-2" value={item.priceRub} onChange={(priceRub) => update({ prices: replaceAt(facts.prices, index, { priceRub: priceRub === null || priceRub <= 0 ? item.priceRub : priceRub }) })} />
          </Row>
        ))}
        {overflowNote(facts.prices.length)}
      </Group>

      <Group title="Регионы работы" count={facts.regions.length}>
        {facts.regions.map((region, index) => (
          <div key={`${region}-${String(index)}`} className="flex items-center gap-2">
            <TextInput label="Регион" className="flex-1" value={region} onChange={(next) => update({ regions: facts.regions.map((item, i) => (i === index ? next : item)) })} />
            <RemoveButton what={region} onClick={() => update({ regions: removeAt(facts.regions, index) })} />
          </div>
        ))}
      </Group>

      <Group title="Примечания" count={facts.notes.length}>
        {facts.notes.map((note, index) => (
          <div key={`${note}-${String(index)}`} className="flex items-center gap-2">
            <TextInput label="Примечание" className="flex-1" value={note} onChange={(next) => update({ notes: facts.notes.map((item, i) => (i === index ? next : item)) })} />
            <RemoveButton what={note} onClick={() => update({ notes: removeAt(facts.notes, index) })} />
          </div>
        ))}
      </Group>
    </div>
  );
}
