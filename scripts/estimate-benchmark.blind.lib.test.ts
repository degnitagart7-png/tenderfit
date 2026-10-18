import { describe, expect, it } from "vitest";

import { compareBlind, type BlindCustomerPosition, type BlindOurLine } from "../src/domain/estimate/benchmarkBlind";
import { EMPTY_GENERATED_STATS, type GeneratedStats } from "../src/domain/estimate/generatedItems";
import { EMPTY_NORM_PICK_STATS, type NormPickStats } from "../src/domain/estimate/normPick";
import { BLIND_JOB_PREFIX, blindJobId, expectedModelCalls, formatBlindSummary, type BlindTenderReport } from "./estimate-benchmark.blind.lib";

const customer: BlindCustomerPosition[] = [
  { lsr: "02-02-08", label: "1", sub: false, code: "ГЭСН01-01-001-01", name: "Разработка грунта", unit: "100 м3", quantity: 2, total: 1000 },
  { lsr: "02-02-08", label: "2", sub: false, code: "ГЭСН15-06-001-01", name: "Окраска стен водоэмульсионной краской", unit: "м2", quantity: 8, total: 800 },
  { lsr: "02-02-08", label: "3", sub: false, code: "ГЭСН09-03-002-01", name: "Монтаж кабеля", unit: "м", quantity: 40, total: 150 },
];
const ours: BlindOurLine[] = [
  {
    itemId: "d1c1-1",
    normBaseType: "ГЭСН",
    normCode: "01-01-001-01",
    normName: "Разработка грунта",
    normUnit: "100 м3",
    quantity: 2.4,
    billQuantity: 240,
    billUnit: "м3",
    total: 1200,
    sourceQuote: "грунт 240 м3 | со вставкой",
    sourceDocument: "ТЗ.docx",
    priceSource: null,
  },
  {
    itemId: "d1c1-2",
    normBaseType: "ГЭСН",
    normCode: "15-04-005-01",
    normName: "Окраска стен водоэмульсионными составами",
    normUnit: "100 м2",
    quantity: 0.08,
    billQuantity: 8,
    billUnit: "м2",
    total: 700,
    sourceQuote: null,
    sourceDocument: "ТЗ.docx",
    priceSource: null,
  },
];

function report(spec: Partial<BlindTenderReport> & Pick<BlindTenderReport, "tenderId" | "status">): BlindTenderReport {
  return {
    regNumber: null,
    message: null,
    zone: null,
    zoneNotes: [],
    method: null,
    period: null,
    removal: null,
    customer: null,
    volumeLevel: null,
    volumeNote: null,
    volumeDocuments: [],
    tokensUsed: null,
    modelCalls: 0,
    modelDocuments: [],
    billItems: null,
    rejected: null,
    documentsWithoutBill: [],
    gapCounts: {},
    normPick: null,
    aiMaterials: [],
    generated: null,
    comparison: null,
    durationMs: 1,
    ...spec,
  };
}

const ok = report({
  tenderId: "0302300048726001118",
  status: "OK",
  zone: { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", basis: "TENDER_REGION", matched: "Бурятия" },
  method: "RESOURCE_INDEX",
  removal: {
    originalDocuments: 3,
    originalChars: 100_000,
    usedDocuments: [{ name: "Проект контракта.doc.zip", chars: 1336, originalChars: 3850 }],
    remainingChars: 1336,
    dropped: [{ name: "Описание объекта закупки.rar.zip", originalChars: 44689, leftoverChars: 0 }],
    removed: [
      { document: "Описание объекта закупки.rar.zip", kind: "LSR", label: "ЛСР 02-02-08", chars: 24583 },
      { document: "Проект контракта.doc.zip", kind: "CONTRACT_ESTIMATE", label: null, chars: 1937 },
    ],
    leaks: [],
    warnings: ["«Обоснование НМЦК.rar.zip»: пример предупреждения"],
    expectedModelCalls: 1,
  },
  customer: { lsrs: 1, positions: 3, totalExVat: 2000, positionsTotal: 1950, declared: ["Республика Бурятия / Республика Бурятия (5 зона), II кв. 2026 (01.04.2026)"] },
  volumeLevel: "SPEC",
  volumeNote: "ТЗ",
  volumeDocuments: ["ТЗ.docx"],
  tokensUsed: 12_345,
  modelCalls: 2,
  modelDocuments: ["ТЗ.docx"],
  billItems: 2,
  rejected: 0,
  comparison: compareBlind({ customer, ours, ourWorkTotal: 1900, customerLsrTotal: 2000 }),
});

describe("материалы, подобранные ИИ, в сводке и отчёте", () => {
  const material = {
    kind: "NORM_MATERIAL" as const,
    itemId: "bitumen",
    lineName: "Устройство кровель из листов волнистых битумных",
    norm: "ГЭСН 12-01-007-12",
    lineTotal: 675223,
    normResource: { code: "12.1.02.06", name: "Листы волнистые битумные" },
    picked: { code: "12.1.02.06-0001", name: "Лист волнистый битумный", unit: "м2" },
    quantity: 504,
    unitPrice: 520,
    total: 262080,
    pick: "AI" as const,
    review: false,
    reason: "битумный волнистый лист",
    confidence: "high" as const,
  };
  const withMaterials = { ...ok, aiMaterials: [material] };

  it("раздел «Материалы, подобранные ИИ» по закупке со сравнением: позиция, норма, ресурс нормы, материал, уверенность, обоснование", () => {
    const text = formatBlindSummary([withMaterials], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 15 }).replace(/[\u00a0\u202f]/gu, " ");
    expect(text).toContain("### 0302300048726001118: Материалы, подобранные ИИ (1 из 1 по рублям");
    expect(text).toContain("12.1.02.06 Листы волнистые битумные");
    expect(text).toContain("12.1.02.06-0001 Лист волнистый битумный, м2");
    expect(text).toContain("262 080,00");
    expect(text).toContain("высокая");
    expect(text).toContain("битумный волнистый лист");
  });

  it("без материалов раздела нет; в JSON отчёта материалы сохраняются", () => {
    expect(formatBlindSummary([ok], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 15 })).not.toContain("Материалы, подобранные ИИ");
    const parsed = JSON.parse(JSON.stringify(withMaterials)) as BlindTenderReport;
    expect(parsed.aiMaterials).toEqual([material]);
  });
});

describe("метка расхода модели", () => {
  it("job_id начинается с метки бенчмарка и не длиннее предела ручки", () => {
    expect(BLIND_JOB_PREFIX).toBe("bench-blind:");
    expect(blindJobId("0302300048726001118")).toBe("bench-blind:0302300048726001118");
    expect(blindJobId("x".repeat(100))).toHaveLength(64);
  });

  it("ожидаемое число вызовов: фрагмент — 100 000 знаков, пустой документ не считается", () => {
    expect(expectedModelCalls([{ text: "a".repeat(100_000) }, { text: "a".repeat(100_001) }, { text: "" }])).toBe(3);
    expect(expectedModelCalls([])).toBe(0);
  });
});

describe("formatBlindSummary", () => {
  const text = formatBlindSummary(
    [
      ok,
      report({ tenderId: "0111", status: "LEAK", message: "смета заказчика осталась во входе: Смета.pdf" }),
      report({ tenderId: "0222", status: "NO_LSR", message: "локальных смет формы 421/пр в документах нет" }),
    ],
    { generatedAt: "2026-10-10T00:00:00.000Z", topN: 15 },
  );

  it("общие пояснения: что вырезано, что пишется в базу, метка расхода", () => {
    expect(text).toContain("# Бенчмарк «вслепую»");
    expect(text).toContain("расчёт ничего не сохраняет");
    expect(text).toContain("bench-blind:");
  });

  it("таблица закупок: статус, зона, источник объёмов, токены, итоги, Δ, покрытие, счётчики, медиана объёмов", () => {
    expect(text).toContain("| Закупка | Статус | Наша зона | Зона заказчика | Метод | Источник объёмов | Токены |");
    // Intl разделяет разряды неразрывным пробелом: для проверки он приводится к обычному.
    const row = text
      .replace(/[\u00a0\u202f]/g, " ")
      .split("\n")
      .find((line) => line.startsWith("| 0302300048726001118 | OK "));
    expect(row).toBeDefined();
    expect(row).toContain("Республика Бурятия (5 зона) (236)");
    expect(row).toContain("РИМ");
    expect(row).toContain("ТЗ и спецификации");
    expect(row).toContain("12 345");
    // Наш итог 1900 против позиций 1950 и итога ЛСР 2000.
    expect(row).toContain("1 950,00");
    expect(row).toContain("2 000,00");
    expect(row).toContain("1 900,00");
    expect(row).toContain("-2,56 %");
    expect(row).toContain("-5,00 %");
    // Совпало 1 / та же таблица 0 / нет у нас 2 / лишних 1; покрытие по шифру 1000 / 1950 = 51,28 %.
    expect(row).toContain("1 / 0 / 2 / 1");
    expect(row).toContain("51,28 %");
    expect(row).toContain("1,20 (1 шифров)");
  });

  it("статусы без сравнения названы с причиной", () => {
    expect(text).toContain("## Закупки без сравнения");
    expect(text).toMatch(/\| 0111 \| LEAK \| смета заказчика осталась во входе: Смета\.pdf \|/);
    expect(text).toMatch(/\| 0222 \| NO_LSR \|/);
  });

  it("вырезанное: виды отрезков, ушедшие целиком, предупреждения", () => {
    expect(text).toContain("## Что вырезано из входа");
    expect(text).toContain("ЛСР формы 421/пр: 1");
    expect(text).toContain("смета контракта (ЛС … Поз.:): 1");
    expect(text).toContain("Описание объекта закупки.rar.zip");
    expect(text).toContain("пример предупреждения");
  });

  it("главные разрывы с источником нашей строки и похожие по названию позиции", () => {
    expect(text).toContain("## 0302300048726001118: главные разрывы в рублях");
    expect(text).toContain("грунт 240 м3 \\| со вставкой");
    expect(text).toContain("ТЗ.docx");
    expect(text).toContain("нет у нас");
    expect(text).toContain("лишняя у нас");
    expect(text).toContain("### 0302300048726001118: похожие по названию");
    expect(text).toContain("Окраска стен водоэмульсионной краской");
    expect(text).toContain("Окраска стен водоэмульсионными составами");
  });

  it("одна закупка с итогом не плодит строку «Итого», две — плодят", () => {
    expect(text).not.toContain("Итого по");
    const two = formatBlindSummary([ok, { ...ok, tenderId: "0333" }], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(two).toContain("Итого по 2 закупкам с сравнением");
  });

  it("пустой список закупок — таблицы с пометкой «нет данных», без падения", () => {
    const empty = formatBlindSummary([], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 15 });
    expect(empty).toContain("_нет данных_");
  });
});

describe("счётчики «ИИ-сметчика» в отчёте и сводке", () => {
  const pick: NormPickStats = {
    ...EMPTY_NORM_PICK_STATS,
    requested: 12,
    picked: 9,
    rejected: 2,
    fallback: 1,
    tokens: 5400,
    materialRows: 5,
    ambiguousRows: 1,
    materialRequested: 6,
    materialPicked: 3,
    materialRejected: 1,
    materialFallback: 1,
    materialUnpriced: 1,
    normMaterialRequested: 4,
    normMaterialPicked: 2,
    normMaterialDeclined: 1,
    normMaterialRejected: 0,
    normMaterialFallback: 1,
  };

  it("в таблице закупок — нормы ИИ (принято / отправлено / отклонено / без ответа) и материалы (строк / ИИ / по наименованию / без цены / отклонено)", () => {
    const text = formatBlindSummary([{ ...ok, normPick: pick }], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(text).toContain("| ИИ-нормы: принято / отправлено / отклонено / без ответа | Материалы: строк / ресурс ИИ / по наименованию / без цены / отклонено |");
    const row = text.split("\n").find((line) => line.startsWith("| 0302300048726001118 | OK "));
    expect(row).toContain("9 / 12 / 2 / 1");
    expect(row).toContain("5 / 3 / 1 / 1 / 1");
    expect(row).toContain("4 / 2 / 1 / 1 / 0");
  });

  it("итоговая строка суммирует закупки с расчётом; закупки без расчёта не мешают", () => {
    const text = formatBlindSummary([{ ...ok, normPick: pick }, { ...ok, tenderId: "0333", normPick: pick }, report({ tenderId: "0444", status: "NO_LSR" })], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(text).toContain("ИИ-сметчик по 2 закупкам: нормы — отправлено 24, принято 18, отклонено проверкой 4, без ответа 2, токенов 10");
    expect(text).toContain("материалы — строк 10 (неясных 2), ресурс выбрала модель 6, выбран кодом без модели 2, без цены 2, ответ модели отклонён 2;");
    expect(text).toContain("материал нормы «по проекту» — отправлено 8, выбрала модель 4, выбран кодом без модели 2, отказ модели 2, отклонено проверкой 0.");
  });

  it("у закупки без расчёта ячейки пустые, а не нули; отчёт сериализуется в JSON вместе со счётчиками", () => {
    const withoutRun = report({ tenderId: "0555", status: "LEAK" });
    expect(withoutRun.normPick).toBeNull();
    const parsed = JSON.parse(JSON.stringify({ ...ok, normPick: pick })) as BlindTenderReport;
    expect(parsed.normPick).toMatchObject({ requested: 12, materialRows: 5, materialPicked: 3, materialUnpriced: 1 });
  });
});


describe("строки, добавленные расчётом и ИИ, в отчёте и сводке", () => {
  const generated: GeneratedStats = {
    debris: { enabled: true, rows: 3, tons: 1.726, distanceKm: 51, unpriced: 1, skipped: null, rub: 1285.25 },
    implied: { enabled: true, proposed: 3, accepted: 2, rejected: 1, failed: 0, tokens: 1500, rub: 260_000, skipped: null, notes: ["«Лес»: формула …"] },
  };
  const withGenerated = (): BlindTenderReport => {
    const base = ok.comparison as NonNullable<BlindTenderReport["comparison"]>;
    const compared = compareBlind({
      customer,
      ours: [
        ...ours,
        {
          itemId: "gen-ai-1",
          normBaseType: "ГЭСН",
          normCode: "09-03-002-01",
          normName: "Установка и разборка наружных инвентарных лесов",
          normUnit: "м",
          quantity: 40,
          billQuantity: 40,
          billUnit: "м",
          total: 300,
          sourceQuote: "добавлено ИИ: леса; объём = max(#1, #2) = 40 м",
          sourceDocument: null,
          priceSource: null,
          generated: "AI_IMPLIED",
        },
      ],
      ourWorkTotal: 2200,
      customerLsrTotal: 2000,
      generatedUnpriced: [{ itemId: "gen-debris-disposal", kind: "DEBRIS", name: "Размещение (утилизация) строительного мусора", unit: "т", quantity: 1.726, reason: "тариф полигона не известен — укажите свою цену" }],
    });
    expect(base).toBeDefined();
    return { ...ok, generated, comparison: compared };
  };

  it("в таблице закупок — колонка «Добавлено сверх ведомости» с мусором (строк, т, ₽, без цены) и работами ИИ (принято из предложенных, ₽)", () => {
    const text = formatBlindSummary([withGenerated()], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(text).toContain("Добавлено сверх ведомости (мусор; работы по технологии ИИ)");
    const row = text
      .replace(/[\u00a0\u202f]/g, " ")
      .split("\n")
      .find((line) => line.startsWith("| 0302300048726001118 | OK "));
    expect(row).toContain("мусор: 3 стр. / 1,73 т / 1 285,25 ₽ (без цены 1); ИИ: 2 из 3 / 260 000,00 ₽");
  });

  it("итоговая строка суммирует закупки с расчётом", () => {
    const text = formatBlindSummary([withGenerated(), { ...withGenerated(), tenderId: "0333" }], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    const flat = text.replace(/[\u00a0\u202f]/g, " ");
    expect(flat).toContain("Строки сверх ведомости по 2 закупкам: мусор — строк 6, 3,45 т, 2 570,50 ₽ (без цены 2); работы по технологии от ИИ — предложено 6, принято 4, отклонено проверкой 2, 520 000,00 ₽, токенов 3 000.");
  });

  it("по закупке — отдельный раздел: совпала ли добавленная строка с позицией заказчика, и список строк без цены с причиной", () => {
    const text = formatBlindSummary([withGenerated()], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(text).toContain("### 0302300048726001118: строки, добавленные расчётом и ИИ сверх ведомости");
    expect(text).toContain("Добавлено строк с ценой 1 на 300,00 ₽");
    expect(text).toContain("Совпало с заказчиком по шифру 1, по таблице 0");
    expect(text).toContain("ИИ (технология)");
    expect(text).toContain("совпал шифр с заказчиком");
    expect(text).toContain("Размещение (утилизация) строительного мусора");
    expect(text).toContain("тариф полигона не известен — укажите свою цену");
    expect(text).toContain("добавлено ИИ: леса; объём = max(#1, #2) = 40 м");
  });

  it("закупка без добавленных строк раздела не получает; пустые счётчики не печатают нулевых итогов; отчёт сериализуется в JSON", () => {
    const text = formatBlindSummary([ok], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(text).not.toContain("строки, добавленные расчётом и ИИ сверх ведомости");
    expect(text).not.toContain("Строки сверх ведомости по");
    const empty = formatBlindSummary([{ ...ok, generated: EMPTY_GENERATED_STATS }], { generatedAt: "2026-10-10T00:00:00.000Z", topN: 5 });
    expect(empty).toContain("мусор: выкл.; ИИ: выкл.");
    const parsed = JSON.parse(JSON.stringify(withGenerated())) as BlindTenderReport;
    expect(parsed.generated).toMatchObject({ debris: { rows: 3, tons: 1.726 }, implied: { accepted: 2 } });
    expect(parsed.comparison?.generated.lines[0]).toMatchObject({ itemId: "gen-ai-1", kind: "AI_IMPLIED" });
  });
});
