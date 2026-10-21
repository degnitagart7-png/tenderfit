"use client";

import { useMemo, useState } from "react";

import { BidEconomicsCard } from "@/components/estimate/BidEconomicsCard";
import type { TaxSystem } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import { auditBidBase, auditBidBaseTotal } from "@/domain/estimate/bidAuditBase";
import { estimateTitles } from "@/domain/estimate/auditEstimateTitle";
import type { CompanyCostProfile } from "@/domain/estimate/companyCostProfile";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import type { AuditJobData } from "@/hooks/useEstimateJob";

/**
 * «Экономика участия» по проверке сметы заказчика.
 *
 * Проверка пересчитывает смету заказчика по ценам нашей зоны и квартала. Для подрядчика это основа себестоимости: «сколько
 * стоит сделать то, что просит заказчик». Блок строит по ней ту же экономику, что и по нашей смете: безубыточная цена,
 * минимальная цена с вашей маржой, допустимое снижение, «моя цена» и Excel.
 *
 * НМЦК. На экране «Смета» закупки нет: НМЦК — итог самой сметы заказчика (его можно поправить в блоке «Моя цена»). На карточке
 * закупки с одной сметой берётся настоящая НМЦК закупки и закон; со многими сметами сравнивать одну ЛСР с ценой всей закупки
 * нельзя — берётся итог выбранной сметы, как на экране «Смета». Налоговая система и минимальная маржа — из профиля компании.
 */

export interface AuditBidTender {
  /** НМЦК закупки, ₽; null — не объявлена. */
  readonly nmc: number | null;
  readonly law?: TenderLaw;
  readonly vat?: VatStatus;
}

export function AuditBidEconomics({
  audit,
  company,
  costProfile,
  onCostProfileChange,
  tender,
  subject,
}: {
  audit: AuditJobData;
  company: { readonly taxSystem: TaxSystem; readonly minMarginPercent: number } | null;
  costProfile?: CompanyCostProfile;
  onCostProfileChange?: (next: CompanyCostProfile) => void;
  tender?: AuditBidTender;
  subject?: string;
}) {
  // Сметы, по которым есть что считать: нулевой итог — пустой разбор, цена из него ничего не скажет.
  const usable = useMemo(() => audit.reports.filter((report) => report.customerTotal > 0 && report.repricedTotal > 0), [audit.reports]);
  const titles = useMemo(() => estimateTitles(usable), [usable]);
  // Смет несколько — по умолчанию считается ИТОГ по всем ("all"): НМЦК закупки покрывает их все. Выбор одной сметы остаётся.
  const [picked, setPicked] = useState<"all" | number>("all");
  if (usable.length === 0) return null;
  const several = usable.length > 1;
  const selected: "all" | number = several ? picked : 0;
  const single = selected === "all" ? undefined : usable[Math.min(selected, usable.length - 1)];
  const base = selected === "all" || single === undefined ? auditBidBaseTotal(usable) : auditBidBase(single);
  if (base === null) return null;
  const useTenderPrice = tender !== undefined && tender.nmc !== null && (selected === "all" || usable.length === 1);
  const title = single === undefined ? `Все сметы (${String(usable.length)})` : (titles[usable.indexOf(single)] as string);

  return (
    <div className="space-y-2" data-testid="audit-bid">
      {several && (
        <label className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Смета
          <select
            className="max-w-full rounded-full border border-border bg-panel px-2 py-0.5 text-foreground"
            value={selected === "all" ? "all" : String(selected)}
            onChange={(event) => setPicked(event.target.value === "all" ? "all" : Number(event.target.value))}
            aria-label="Смета заказчика для расчёта цены"
          >
            <option value="all">Все сметы вместе ({usable.length})</option>
            {usable.map((item, index) => (
              <option key={`${item.documentName}-${item.estimateName ?? ""}-${String(index)}`} value={String(index)}>
                {titles[index]}
              </option>
            ))}
          </select>
        </label>
      )}
      <BidEconomicsCard
        // Новый выбор — новое состояние карточки: введённая цена и НМЦК относились к другому набору смет.
        key={String(selected)}
        costBase={base.costBase}
        unverifiedPercent={base.unverifiedPercent}
        nmc={useTenderPrice ? (tender?.nmc ?? null) : base.nmc}
        nmcEditable
        nmcIncludesVat={useTenderPrice ? undefined : base.nmcIncludesVat}
        billItems={base.billItems}
        droppedPositions={0}
        assumedPercent={0}
        unpricedResources={0}
        taxSystem={company?.taxSystem ?? "OSNO"}
        minMarginPercent={company?.minMarginPercent ?? 0}
        law={useTenderPrice ? tender?.law : undefined}
        vat={useTenderPrice ? tender?.vat : undefined}
        subject={subject !== undefined && subject.trim() !== "" ? `${subject.trim()} — ${title}` : title}
        costProfile={costProfile}
        onCostProfileChange={onCostProfileChange}
        notes={[
          useTenderPrice
            ? "НМЦК — цена закупки."
            : selected === "all"
              ? "НМЦК принята равной сумме итогов смет заказчика — поправьте её в блоке «Моя цена», если цена закупки другая."
              : "НМЦК принята равной итогу сметы заказчика — поправьте её в блоке «Моя цена», если цена закупки другая.",
          selected === "all" ? "Себестоимость — все сметы заказчика по нашим ценам зоны и нормативам НР; сметная прибыль в неё не входит." : "Себестоимость — смета заказчика по нашим ценам зоны и нормативам НР; сметная прибыль в неё не входит.",
        ]}
      />
    </div>
  );
}
