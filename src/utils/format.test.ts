import { describe, expect, it } from "vitest";
import {
  currencySymbol,
  formatCompactRub,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatFileSize,
  formatTenderPrice,
  formatTimeLeft,
  joinRuList,
  pluralRu,
} from "@/utils/format";

/**
 * Тесты форматирования по стандартам проекта: суммы в ₽, даты дд.мм.гггг,
 * время с пометкой МСК, обратный отсчёт до дедлайна, русские множественные формы.
 */

/** Приводит неразрывный пробел (U+00A0) из ru-RU-формата к обычному для сравнения. */
const NBSP = String.fromCharCode(160);
const nbsp = (s: string): string => s.split(NBSP).join(" ");

describe("formatCurrency", () => {
  it("сумма в рублях с разделителями разрядов", () => {
    expect(nbsp(formatCurrency(1_400_000))).toBe("1 400 000 ₽");
    expect(nbsp(formatCurrency(800_000))).toBe("800 000 ₽");
  });

  it("null и undefined — прочерк", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
  });
});

describe("formatTenderPrice", () => {
  it("опубликованная цена — сумма в рублях", () => {
    expect(nbsp(formatTenderPrice(1_093_411.81))).toBe("1 093 411,81 ₽");
  });

  it("нуль и пусто — цена не указана, а не «0 ₽»", () => {
    expect(formatTenderPrice(0)).toBe("Не указана");
    expect(formatTenderPrice(null)).toBe("Не указана");
    expect(formatTenderPrice(undefined)).toBe("Не указана");
  });

  it("валюта закупки печатается вместо рубля", () => {
    // Коммерческие закупки объявляются в долларах и юанях; «1 000 ₽» вместо
    // «1 000 $» — неверные данные на экране, а не косметика.
    expect(nbsp(formatTenderPrice(1_000, "USD"))).toBe("1 000 $");
    expect(nbsp(formatTenderPrice(1_000, "CNY"))).toBe("1 000 ¥");
    expect(nbsp(formatTenderPrice(1_000, "RUB"))).toBe("1 000 ₽");
  });

  it("пустая и неизвестная валюта не меняют показ", () => {
    expect(nbsp(formatTenderPrice(1_000, ""))).toBe("1 000 ₽");
    expect(nbsp(formatTenderPrice(1_000, null))).toBe("1 000 ₽");
    // Неизвестный код показываем как есть: выдумывать знак хуже.
    expect(nbsp(formatTenderPrice(1_000, "AED"))).toBe("1 000 AED");
  });
});

describe("currencySymbol", () => {
  it("знак по коду, регистр и пробелы не важны", () => {
    expect(currencySymbol("RUB")).toBe("₽");
    expect(currencySymbol("usd")).toBe("$");
    expect(currencySymbol(" EUR ")).toBe("€");
    expect(currencySymbol("BYN")).toBe("Br");
    expect(currencySymbol("KZT")).toBe("₸");
  });

  it("пусто и неизвестный код", () => {
    expect(currencySymbol("")).toBe("₽");
    expect(currencySymbol(null)).toBe("₽");
    expect(currencySymbol(undefined)).toBe("₽");
    expect(currencySymbol("XYZ")).toBe("XYZ");
  });
});

describe("formatDate", () => {
  it("дата в формате дд.мм.гггг", () => {
    expect(formatDate("2026-09-22T10:00:00")).toBe("22.09.2026");
    expect(formatDate("2026-01-05T00:00:00")).toBe("05.01.2026");
  });

  it("пусто и не-дата — прочерк", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("не дата")).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("дата и время с пометкой МСК", () => {
    expect(formatDateTime("2026-09-22T10:05:00+03:00")).toBe("22.09.2026, 10:05 МСК");
    // Срок в поясе заказчика (Иркутск, МСК+5) печатается по Москве, а не по браузеру.
    expect(formatDateTime("2026-10-15T00:00:00Z")).toBe("15.10.2026, 03:00 МСК");
    expect(formatDateTime("2026-12-31T22:30:00Z")).toBe("01.01.2027, 01:30 МСК");
  });

  it("пусто — прочерк", () => {
    expect(formatDateTime(null)).toBe("—");
  });
});

describe("formatTimeLeft", () => {
  const now = new Date("2026-09-21T12:00:00");

  it("менее суток — отдельная формулировка с часами", () => {
    expect(formatTimeLeft("2026-09-21T20:00:00", now)).toBe(
      "осталось менее суток (8 ч)",
    );
  });

  it("дни и часы", () => {
    expect(formatTimeLeft("2026-09-23T15:00:00", now)).toBe(
      "осталось 2 дн. 3 ч",
    );
  });

  it("истёкший срок — подача завершена", () => {
    expect(formatTimeLeft("2026-09-20T12:00:00", now)).toBe("подача завершена");
  });

  it("не-дата — прочерк", () => {
    expect(formatTimeLeft("мусор", now)).toBe("—");
  });
});

describe("pluralRu", () => {
  const forms: [string, string, string] = ["закупка", "закупки", "закупок"];

  it("выбирает форму по числу", () => {
    expect(pluralRu(1, forms)).toBe("закупка");
    expect(pluralRu(2, forms)).toBe("закупки");
    expect(pluralRu(5, forms)).toBe("закупок");
    expect(pluralRu(11, forms)).toBe("закупок");
    expect(pluralRu(21, forms)).toBe("закупка");
    expect(pluralRu(122, forms)).toBe("закупки");
  });
});

describe("formatFileSize", () => {
  it("байты, килобайты и мегабайты — по размеру", () => {
    expect(formatFileSize(512)).toBe("512 Б");
    expect(formatFileSize(432_708)).toBe("423 КБ");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5 МБ");
  });

  it("без размера — прочерк", () => {
    expect(formatFileSize(null)).toBe("—");
    expect(formatFileSize(undefined)).toBe("—");
  });
});

describe("formatCompactRub", () => {
  it("печатает масштаб, а не точную сумму", () => {
    expect(formatCompactRub(12_437_812)).toBe("12,4 млн ₽");
    expect(formatCompactRub(860_000)).toBe("860 тыс ₽");
    expect(formatCompactRub(1_250_000_000)).toBe("1,3 млрд ₽");
  });

  it("от десяти единиц дробная часть уже не нужна", () => {
    expect(formatCompactRub(124_300_000)).toBe("124 млн ₽");
  });

  it("мелкие суммы печатаются целиком", () => {
    expect(formatCompactRub(840)).toBe("840 ₽");
  });

  it("нет суммы — прочерк, а не ноль", () => {
    expect(formatCompactRub(null)).toBe("—");
    expect(formatCompactRub(0)).toBe("—");
  });
});

describe("formatCompactRub — ровные значения", () => {
  it("не печатает хвостовой ноль", () => {
    expect(formatCompactRub(1_000_000)).toBe("1 млн ₽");
    expect(formatCompactRub(2_000_000_000)).toBe("2 млрд ₽");
  });
});

describe("joinRuList", () => {
  it("перечисляет через запятую, а последнее присоединяет союзом", () => {
    expect(joinRuList(["ЕИС", "ТЭК-Торг", "Сбербанк-АСТ"])).toBe(
      "ЕИС, ТЭК-Торг и Сбербанк-АСТ",
    );
  });

  it("два элемента — без запятой", () => {
    expect(joinRuList(["ЕИС", "ТЭК-Торг"])).toBe("ЕИС и ТЭК-Торг");
  });

  it("один элемент возвращается как есть", () => {
    expect(joinRuList(["ЕИС"])).toBe("ЕИС");
  });

  it("пустой список — пустая строка, а не висячий союз", () => {
    expect(joinRuList([])).toBe("");
  });
});
