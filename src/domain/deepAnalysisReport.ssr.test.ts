import { describe, expect, it } from "vitest";

import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import { buildDeepAnalysisReport, type ReportBlock } from "@/domain/deepAnalysisReport";
import { computeBidEconomics } from "@/domain/estimate/bidEconomics";
import { SSR_377_CSV, SSR_BAD } from "@/domain/estimate/customerSsr.fixtures";
import { NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { computeSsrLayer } from "@/domain/estimate/ssrLayer";
import { demoTenders } from "@/mocks/tenders";
import { ssrEstimate } from "@/test/ssrFixtures";

/*
  Word, раздел «Смета и цена участия», подраздел «Сводный расчёт»: наш ССР и цена контракта по строкам, сравнение с НМЦК,
  аудит ССР заказчика. Те же числа, что на экране.
*/

const tender = demoTenders[0]!;
const NOW = new Date("2026-10-08T12:00:00Z");
const NMC = 2_032_153.32;
const OPTIONS: EstimateOptions = { ...NO_ESTIMATE_OPTIONS, workKind: "CR_FACADE", workPeriod: { start: "2026-10-01", end: "2026-11-30" } };
const SUMMARY = {
  state: "completed", title: "", detail: "", job: null, documents: [], documentsWithText: 0, documentsSkipped: 0, documentsTruncated: 0,
  chunksAnalyzed: 0, findings: [], findingGroups: [], modelUsed: null, verdictChange: null,
} as unknown as DeepAnalysisSummary;

const flat = (value: string): string => value.replace(/[\s  ]/gu, " ");

function layerOf(documents: { name: string; text: string }[], withEstimate = true, nmc: number | null = NMC) {
  return computeSsrLayer({
    estimate: withEstimate ? ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_623_390 }] }) : null,
    options: OPTIONS,
    nmc,
    nmcIncludesVat: true,
    priceDate: "2026-10-01",
    today: "2026-10-09",
    documents,
  });
}

function section(documents: { name: string; text: string }[], opts: { withEstimate?: boolean; withSsr?: boolean; nmc?: number | null } = {}) {
  const { withEstimate = true, withSsr = true, nmc = NMC } = opts;
  const layer = layerOf(documents, withEstimate, nmc);
  const bidEconomics = withEstimate
    ? computeBidEconomics({
        document: ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_623_390 }] }),
        nmc,
        billItems: 10,
        droppedPositions: 0,
        assumedPercent: 0,
        unpricedResources: 0,
        company: { taxSystem: "OSNO", minMarginPercent: 10 },
        ssr: withSsr ? layer.ssr : null,
      })
    : null;
  const report = buildDeepAnalysisReport({
    regNumber: tender.regNumber,
    subject: tender.subject,
    summary: SUMMARY,
    generatedAt: NOW,
    tender,
    bidEconomics,
    ssr: withSsr ? { result: layer.ssr, comparison: layer.comparison, audits: layer.audits } : null,
  });
  return report.sections.find((item) => item.title === "Смета и цена участия")!;
}

const textOf = (blocks: readonly ReportBlock[]): string => flat(JSON.stringify(blocks));

describe("Word: подраздел «Сводный расчёт»", () => {
  const blocks = section([{ name: "ССРСС.xlsx", text: SSR_377_CSV }]).blocks;
  const text = textOf(blocks);

  it("есть подзаголовок и строка «Наша оценка НМЦК … против НМЦК закупки … (разница …)»", () => {
    expect(blocks.some((block) => block.kind === "paragraph" && block.text === "Сводный расчёт" && block.bold === true)).toBe(true);
    expect(text).toMatch(/Наша оценка НМЦК: [\d ]+ ₽ против НМЦК закупки 2 032 153 ₽ \(с НДС; разница [+−]?\d,\d %\)/u);
  });

  it("таблица по строкам: у нас, у заказчика, разница, основание", () => {
    const table = blocks.find((block) => block.kind === "table" && block.columns[0]?.title === "Строка");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.columns.map((column) => column.title)).toEqual(["Строка", "У нас, ₽", "У заказчика, ₽", "Разница, ₽", "Основание"]);
    expect(table.rows.map((row) => row[0]?.text)).toEqual([
      "Локальные сметы",
      "Временные здания и сооружения",
      "Зимнее удорожание",
      "Непредвиденные затраты",
      "Прогнозная инфляция",
      "НДС",
      "Без НДС",
      "Наша оценка НМЦК с НДС",
    ]);
    const reserve = table.rows.find((row) => row[0]?.text === "Непредвиденные затраты")!;
    expect(flat(reserve[2]?.text ?? "")).toBe("32 514,40");
    expect(reserve[4]?.text).toContain("п. 179");
    expect(table.rows.find((row) => row[0]?.text === "Временные здания и сооружения")?.[2]?.text).toBe("—");
  });

  it("главы 1-12 и итоги по группам, индекс прогнозной инфляции с формулой, главы заказчика не входят", () => {
    expect(text).toContain("Глава 10. Служба заказчика, строительный контроль");
    expect(text).toContain("Итого по главам 1-9");
    expect(text).toContain("Индекс прогнозной инфляции 1,0047 за период октябрь 2026 — ноябрь 2026: (1,0000 + 1,0095) / 2 = 1,0047");
    expect(text).toContain("Главы 10-12");
    expect(text).toContain("в цену подрядного контракта не входят");
  });

  it("основания: резерв по п. 179, ставка НДС не названа в приказе, резерв — деньги заказчика на риск", () => {
    expect(text).toContain("Резерв на непредвиденные: 2 % от итога глав 1-12");
    expect(text).toContain("Ставка НДС в 421/пр не названа");
    expect(text).toContain("Это деньги заказчика на риск");
  });

  it("в таблице экономики — наша оценка НМЦК и подпись, что резерв в себестоимость не входит", () => {
    expect(text).toContain("Наша оценка НМЦК (цена контракта), без НДС");
    expect(text).toContain("без резерва на непредвиденные (деньги заказчика на риск)");
    expect(text).toContain("от нашей оценки НМЦК");
  });
});

describe("Word: аудит ССР заказчика", () => {
  it("находки с типом, пунктом приказа и влиянием на НМЦК", () => {
    const blocks = section([{ name: "ССРСС.xlsx", text: SSR_BAD }], { nmc: 1_813_280.4 }).blocks;
    const text = textOf(blocks);
    expect(text).toContain("Аудит сводного сметного расчёта заказчика");
    expect(text).toContain("Затраты заказчика в цене контракта");
    expect(text).toContain("НДС 20 % вместо 22 %");
    expect(text).toContain("841/пр, п. 21; 421/пр, п. 162, 170, 171");
    const table = blocks.find((block) => block.kind === "table" && block.columns[0]?.title === "Тип");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.columns.map((column) => column.title)).toEqual(["Тип", "Находка", "Влияние на НМЦК", "Пункт"]);
    expect(table.rows.some((row) => /^[+−][\d ]+ ₽$/u.test(flat(row[2]?.text ?? "")))).toBe(true);
  });

  it("нет ССР в документах — подраздела аудита нет", () => {
    const text = textOf(section([]).blocks);
    expect(text).not.toContain("Аудит сводного сметного расчёта заказчика");
    expect(text).toContain("Сводный расчёт");
  });

  it("смета не посчитана, а ССР заказчика есть — аудит в отчёте остаётся", () => {
    const text = textOf(section([{ name: "ССРСС.xlsx", text: SSR_BAD }], { withEstimate: false, nmc: 1_813_280.4 }).blocks);
    expect(text).toContain("Смета не рассчитана");
    expect(text).toContain("Аудит сводного сметного расчёта заказчика");
  });
});

describe("регресс: без ССР отчёт прежний", () => {
  it("подраздела «Сводный расчёт» и строки «Наша оценка НМЦК» нет", () => {
    const text = textOf(section([], { withSsr: false }).blocks);
    expect(text).not.toContain("Сводный расчёт");
    expect(text).not.toContain("Наша оценка НМЦК");
  });
});
