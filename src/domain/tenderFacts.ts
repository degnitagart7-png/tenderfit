import type { Tender } from "@/domain/entities";
import type { DocumentTermKind } from "@/domain/documentTerms";
import {
  CRITICAL_DEADLINE_HOURS,
  URGENT_DEADLINE_DAYS,
} from "@/domain/scoring";
import { formatCompactRub, pluralRu } from "@/utils/format";
import { calendarDaysLeft, isDateOnlyDeadline } from "@/domain/deadline";

/**
 * Короткие факты закупки для строки ленты: то, что подрядчик проверяет до
 * того, как открыть карточку, — сколько осталось до подачи, сколько денег
 * заморозит обеспечение, есть ли аванс, допустят ли его вообще (СМП).
 *
 * Правило отбора — как у заказчика и региона в таблице: неизвестное не
 * печатается. Большинство площадок обеспечение и аванс в выдаче не отдают,
 * и строка «Обесп. заявки: —» в каждой второй строке читалась бы как поломка.
 */

export type CountdownTone = "danger" | "warning" | "neutral" | "closed";

export interface DeadlineCountdown {
  text: string;
  tone: CountdownTone;
}

/**
 * Сколько осталось до окончания подачи, словами.
 *
 * Тон совпадает с порогами экрана «Сегодня»: меньше суток — красный (тот же
 * `CRITICAL_DEADLINE_HOURS`, что у оранжевой риски строки), до
 * `URGENT_DEADLINE_DAYS` — золотой, как блок «Срочно». Неразобранная дата
 * даёт null: «осталось NaN дней» хуже, чем ничего.
 */
export function deadlineCountdown(
  submissionEnd: string,
  now: Date = new Date(),
): DeadlineCountdown | null {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return null;
  // Срок без времени (выдача ЕИС): считаем днями, часов мы не знаем — см. `deadline.ts`.
  if (isDateOnlyDeadline(submissionEnd)) {
    const left = calendarDaysLeft(submissionEnd, now);
    if (left < 0) return { text: "приём закрыт", tone: "closed" };
    if (left === 0) return { text: "сегодня последний день", tone: "danger" };
    if (left === 1) return { text: "завтра последний день", tone: "danger" };
    return {
      text: `ещё ${left} ${pluralRu(left, ["день", "дня", "дней"])}`,
      tone: left <= URGENT_DEADLINE_DAYS ? "warning" : "neutral",
    };
  }
  const hours = (end - now.getTime()) / (1000 * 60 * 60);
  if (hours <= 0) return { text: "приём закрыт", tone: "closed" };
  if (hours < CRITICAL_DEADLINE_HOURS) {
    const h = Math.max(1, Math.floor(hours));
    return {
      text: `ещё ${h} ${pluralRu(h, ["час", "часа", "часов"])}`,
      tone: "danger",
    };
  }
  const days = Math.floor(hours / 24);
  return {
    text: `ещё ${days} ${pluralRu(days, ["день", "дня", "дней"])}`,
    tone: days <= URGENT_DEADLINE_DAYS ? "warning" : "neutral",
  };
}

/**
 * Сумма или процент — что известно. Процент короче и сравним между
 * закупками, поэтому он первый; сумма в рублях — только при рублёвой цене,
 * иначе компактный формат приклеил бы «₽» к долларовой закупке.
 */
function shareOrAmount(
  percent: number | null,
  amount: number | null,
  currency: string,
): string | null {
  if (percent !== null && percent > 0) {
    return `${percent.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
  }
  const rub = currency.trim() === "" || currency.trim().toUpperCase() === "RUB";
  if (amount !== null && amount > 0 && rub) return formatCompactRub(amount);
  return null;
}

export interface MoneyTerm {
  label: string;
  value: string;
  /**
   * Фраза из документации, если значение найдено там, а не в реквизитах
   * площадки; null — реквизит площадки. Лента помечает такие значения, чтобы
   * разбор текста не выдавался за данные реестра.
   */
  quote: string | null;
}

/**
 * Обеспечение заявки, обеспечение контракта и аванс — только известные.
 *
 * «нет» печатается лишь тогда, когда документация прямо пишет «не требуется»:
 * пустое поле площадки — это «неизвестно», а не «не нужно».
 */
export function moneyTerms(tender: Tender): MoneyTerm[] {
  const f = tender.financial;
  const docs = tender.documentTerms ?? null;
  const terms: MoneyTerm[] = [];
  const push = (
    kind: DocumentTermKind,
    label: string,
    value: string | null,
  ) => {
    const doc = docs?.[kind];
    if (doc && !doc.required) {
      terms.push({ label, value: "нет", quote: doc.quote });
    } else if (value) {
      terms.push({ label, value, quote: doc?.quote ?? null });
    }
  };
  push(
    "bidSecurity",
    "Заявка",
    shareOrAmount(f.bidSecurityPercent, f.bidSecurityAmount, f.currency),
  );
  push(
    "contractSecurity",
    "Контракт",
    shareOrAmount(
      f.contractSecurityPercent,
      f.contractSecurityAmount,
      f.currency,
    ),
  );
  push(
    "advance",
    "Аванс",
    shareOrAmount(f.advancePercent, f.advanceAmount, f.currency),
  );
  return terms;
}

export interface ConditionFlag {
  label: string;
  hint: string;
  /** Условие ограничивает круг участников — подсвечивается, а не сереет. */
  restrictive: boolean;
}

/**
 * Условия участия, которые меняют решение «идти или нет».
 *
 * Флаги печатаются только когда условие есть: «не СМП» в каждой строке — шум.
 */
export function conditionFlags(tender: Tender): ConditionFlag[] {
  const flags: ConditionFlag[] = [];
  if (tender.onlyForSmp) {
    flags.push({
      label: "Только СМП",
      hint: "Участвовать могут только субъекты малого предпринимательства и СОНКО",
      restrictive: true,
    });
  }
  if (tender.nationalRegime) {
    flags.push({
      label: "Нацрежим",
      hint: "Действует национальный режим: запреты или ограничения для иностранной продукции",
      restrictive: true,
    });
  }
  if (tender.financial.treasurySupport) {
    flags.push({
      label: "Казначейство",
      hint: "Казначейское сопровождение: оплата через лицевой счёт в казначействе",
      restrictive: false,
    });
  }
  const docs = tender.documents.length;
  if (docs > 0) {
    flags.push({
      label: `${docs} ${pluralRu(docs, ["документ", "документа", "документов"])}`,
      hint: "Документация закупки загружена и доступна для анализа",
      restrictive: false,
    });
  }
  return flags;
}
