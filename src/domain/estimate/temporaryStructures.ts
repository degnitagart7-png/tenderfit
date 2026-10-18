import { formatDecimal, temporaryRow } from "@/domain/estimate/normatives";
import type { AppliedNormative } from "@/domain/estimate/types";
import type { WorkKind } from "@/domain/estimate/workKinds";

/**
 * Временные здания и сооружения по Методике 332/пр (приказ Минстроя России от 19.06.2020 N 332/пр).
 *
 * Что установлено первоисточником (`data/fsnb/normatives/temporary.json`):
 * - норматив — % от итога сметной стоимости строительных и монтажных работ по главам 1-7 (п. 23, 24);
 * - капремонт жилых, социально-культурных, коммунально-бытовых объектов и коммунальной
 *   инфраструктуры — приложение 2 (п. 24); капремонт и реконструкция прочих объектов — приложение 1
 *   с коэффициентом 0,8 (п. 25);
 * - СНОС: норматива в процентах нет, затраты определяются только расчётом по проекту организации работ
 *   по сносу (п. 29) — поэтому для сноса процент не начисляется и это называется в расчёте;
 * - в нормативы не входят временные сооружения и специальные вспомогательные устройства (п. 26-28):
 *   подъездные дороги, вахтовые посёлки и т. п. — по проекту организации строительства.
 */

const SOURCE_TITLE = "Приказ Минстроя России от 19.06.2020 N 332/пр (ред. приказа от 13.08.2024 N 534/пр)";

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export interface TemporaryResult {
  readonly percent: number;
  readonly applied: AppliedNormative;
}

export function computeTemporaryStructures(kind: WorkKind | null): TemporaryResult {
  if (kind === null) {
    return {
      percent: 0,
      applied: {
        code: "TEMPORARY",
        title: "Временные здания и сооружения",
        text: "Норматив зависит от вида работ и объекта",
        value: "0 %",
        source: `${SOURCE_TITLE}, п. 23-25, 29`,
        applied: false,
        reason: "временные здания и сооружения не начислены: не указан вид работ (снос, капитальный ремонт, строительство)",
        missingData: true,
      },
    };
  }
  if (kind.temporary === null) {
    return {
      percent: 0,
      applied: {
        code: "TEMPORARY",
        title: "Временные здания и сооружения",
        text: `Вид работ: ${kind.label}`,
        value: "0 %",
        source: `${SOURCE_TITLE}, п. 29`,
        applied: false,
        reason: `временные здания и сооружения не начислены: ${lowerFirst(kind.temporaryNote ?? "норматива в процентах для этого вида работ нет")}`,
        missingData: false,
      },
    };
  }
  const row = temporaryRow(kind.temporary.row);
  if (row === null) {
    return {
      percent: 0,
      applied: {
        code: "TEMPORARY",
        title: "Временные здания и сооружения",
        text: `Вид работ: ${kind.label}`,
        value: "0 %",
        source: SOURCE_TITLE,
        applied: false,
        reason: `в справочнике нет строки ${kind.temporary.row}`,
      },
    };
  }
  const percent = Number((row.percent * kind.temporary.multiplier).toFixed(4));
  const appendix = row.table === "A1" ? "1" : "2";
  const text = [
    `Норматив «${row.name}»: ${formatDecimal(row.percent)} %`,
    kind.temporary.multiplier === 1
      ? ""
      : `коэффициент ${formatDecimal(kind.temporary.multiplier)} при капитальном ремонте и реконструкции (п. 25)`,
    "база — итог сметной стоимости строительных и монтажных работ (п. 23, 24)",
    "временные сооружения вне норматива (подъездные дороги, вахтовые посёлки и т. п.) не учтены (п. 26-28)",
  ]
    .filter((item) => item !== "")
    .join("; ");
  return {
    percent,
    applied: {
      code: "TEMPORARY",
      title: "Временные здания и сооружения",
      text,
      value: `${formatDecimal(percent)} %`,
      source: `${SOURCE_TITLE}, приложение ${appendix}, п. ${row.item}`,
      applied: true,
    },
  };
}
