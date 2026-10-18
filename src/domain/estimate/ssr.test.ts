import { describe, expect, it } from "vitest";

import { buildSsr, compareSsrWithNmc, purposeOfWorkKind, resolvePurpose, type SsrInput } from "@/domain/estimate/ssr";
import { inflationLine, nmcHeadline, rubText, signedPercentText, ssrTableRows } from "@/domain/estimate/ssrText";
import { ssrEstimate } from "@/test/ssrFixtures";

/** Intl печатает неразрывные пробелы в разрядах: для сравнения со строкой теста — обычные. */
const plain = (value: string): string => value.replace(/[\u00a0\u202f]/gu, " ");

/*
  Сводный сметный расчёт по нашей смете. Числа считаются в уме: смета — два раздела (1 000 000 и 500 000), временные здания 2 %,
  зимнее 5 % от СМР с временными; резерв — процент от итога глав 1-12; НДС 22 % на итог с резервом.
*/

const TWO_SECTIONS = [
  { title: "Фасад", workCost: 1_000_000 },
  { title: "Кровля", workCost: 500_000 },
];

function input(over: Partial<SsrInput> = {}): SsrInput {
  return {
    document: ssrEstimate({ sections: TWO_SECTIONS, temporaryPercent: 2, winterPercent: 5 }),
    purpose: null,
    workKind: null,
    period: null,
    priceDate: "2026-10-01",
    today: "2026-10-09",
    ...over,
  };
}

describe("ССР из нашей локальной сметы: главы и итоги", () => {
  const result = buildSsr(input());
  const chapter = (number: number) => result.chapters.find((item) => item.number === number)!;
  const group = (id: string) => result.groups.find((item) => item.id === id)!;

  it("двенадцать глав; наименования — как в п. 138 421/пр", () => {
    expect(result.chapters).toHaveLength(12);
    expect(chapter(2).title).toBe("Основные объекты строительства, реконструкции, капитального ремонта");
    expect(chapter(8).title).toBe("Временные здания и сооружения");
    expect(chapter(10).title).toBe("Содержание службы заказчика. Строительный контроль");
  });

  it("локальные сметы — в главе 2 строка на раздел; временные — глава 8; зимнее — глава 9, строка 2.1 приложения 9", () => {
    expect(chapter(2).lines.map((line) => line.title)).toEqual(["Локальная смета: Фасад", "Локальная смета: Кровля"]);
    expect(chapter(2).amounts.total).toBe(1_500_000);
    expect(chapter(8).amounts.total).toBe(30_000);
    expect(chapter(8).lines[0]?.ref).toContain("п. 153-157");
    expect(chapter(9).amounts.total).toBe(76_500);
    expect(chapter(9).lines[0]?.ref).toContain("строка 2.1");
  });

  it("все суммы — в графе строительных работ (4), остальные графы нулевые, графа 8 — их сумма", () => {
    expect(chapter(2).amounts).toEqual({ construction: 1_500_000, installation: 0, equipment: 0, other: 0, total: 1_500_000 });
  });

  it("итоги по главам 1-7, 1-8, 1-9, 1-12 нарастающие (п. 143)", () => {
    expect(group("1-7").amounts.total).toBe(1_500_000);
    expect(group("1-8").amounts.total).toBe(1_530_000);
    expect(group("1-9").amounts.total).toBe(1_606_500);
    expect(group("1-12").amounts.total).toBe(1_606_500);
    expect(result.groups.map((item) => item.id)).toEqual(["1-7", "1-8", "1-9", "1-12"]);
  });

  it("главы 1, 10, 11, 12 не оценены, и причина названа: затраты заказчика и нет исходных данных", () => {
    for (const number of [1, 10, 11, 12]) {
      expect(chapter(number).computed).toBe(false);
      expect(chapter(number).amounts.total).toBe(0);
    }
    expect(chapter(10).note).toContain("Затраты заказчика");
    expect(chapter(1).note).toContain("Не оценивалась");
    expect(result.excluded).toEqual(expect.arrayContaining(["глава 10 «Служба заказчика, строительный контроль»", "глава 12 «ПИР, аудит, экспертиза, авторский надзор»"]));
  });

  it("резерв за итогом глав 1-12 (п. 142, 179): 2 % от 1 606 500; НДС 22 % на итог с резервом (п. 181)", () => {
    expect(result.reserve.base).toBe(1_606_500);
    expect(result.reserve.percent).toBe(2);
    expect(result.reserve.amounts.total).toBe(32_130);
    expect(result.afterReserve.total).toBe(1_638_630);
    expect(result.full).toEqual({ beforeVat: 1_638_630, vat: 360_498.6, total: 1_999_128.6 });
  });

  it("таблица для карточки: главы, итоги по группам, резерв, НДС", () => {
    const rows = ssrTableRows(result);
    expect(rows.filter((row) => row.kind === "chapter")).toHaveLength(12);
    expect(rows.find((row) => row.label === "Итого по главам 1-7")?.amount).toBe(1_500_000);
    expect(rows.find((row) => row.label.startsWith("Непредвиденные"))?.amount).toBe(32_130);
    expect(rows.find((row) => row.label === "Глава 10. Служба заказчика, строительный контроль")?.amount).toBeNull();
    expect(rows.at(-1)?.amount).toBe(1_999_128.6);
  });
});

describe("наша оценка НМЦК (цена контракта по 841/пр)", () => {
  it("строки: локальные сметы, временные, зимнее, непредвиденные, инфляция, НДС; без сроков инфляция нулевая", () => {
    const { nmc } = buildSsr(input());
    expect(nmc.rows.map((row) => [row.id, row.amount])).toEqual([
      ["LOCAL", 1_500_000],
      ["TEMPORARY", 30_000],
      ["WINTER", 76_500],
      ["RESERVE", 32_130],
      ["INFLATION", 0],
      ["VAT", 360_498.6],
    ]);
    expect(nmc.inflation.applied).toBe(false);
    expect(nmc.beforeVat).toBe(1_638_630);
    expect(nmc.total).toBe(1_999_128.6);
  });

  it("сроки октябрь-ноябрь 2026: инфляция 1,0047 умножает главы вместе с резервом, НДС — на итог", () => {
    const { nmc } = buildSsr(input({ period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } }));
    const inflation = Math.round(1_638_630 * 0.0047 * 100) / 100;
    expect(nmc.inflation.index).toBe(1.0047);
    expect(nmc.rows.find((row) => row.id === "INFLATION")?.amount).toBeCloseTo(inflation, 2);
    expect(nmc.beforeVat).toBeCloseTo(1_638_630 + inflation, 2);
    expect(nmc.vat).toBeCloseTo((1_638_630 + inflation) * 0.22, 1);
    expect(nmc.total).toBeCloseTo((1_638_630 + inflation) * 1.22, 1);
  });

  it("ссылки на строки: инфляция и резерв названы с пунктом", () => {
    const { nmc } = buildSsr(input({ period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } }));
    expect(nmc.rows.find((row) => row.id === "INFLATION")?.note).toContain("841/пр, п. 22-23");
    expect(nmc.rows.find((row) => row.id === "RESERVE")?.note).toContain("п. 179");
  });

  it("порядок умножений не влияет на итог: резерв × инфляция × НДС", () => {
    const { nmc } = buildSsr(input({ period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } }));
    const direct = 1_606_500 * 1.02 * 1.0047 * 1.22;
    expect(nmc.total).toBeCloseTo(direct, 0);
  });
});

describe("непредвиденные затраты: 2 % и 3 % по назначению объекта (п. 179)", () => {
  it("непроизводственный — 2 %, производственный и линейный — 3 %, уникальный — 10 %", () => {
    expect(buildSsr(input({ purpose: "NON_PRODUCTION" })).reserve.amounts.total).toBe(32_130);
    expect(buildSsr(input({ purpose: "PRODUCTION" })).reserve.amounts.total).toBe(48_195);
    expect(buildSsr(input({ purpose: "UNIQUE" })).reserve.amounts.total).toBe(160_650);
    expect(buildSsr(input({ purpose: "PRODUCTION" })).reserve.percent).toBe(3);
    expect(buildSsr(input({ purpose: "UNIQUE" })).reserve.percent).toBe(10);
  });

  it("назначение по умолчанию — из вида работ: фасады — здание (2 %), сети и дороги — линейные (3 %)", () => {
    expect(resolvePurpose(null, "CR_FACADE")).toMatchObject({ value: "NON_PRODUCTION", basis: "WORK_KIND" });
    expect(resolvePurpose(null, "CR_NET_WATER")).toMatchObject({ value: "PRODUCTION", basis: "WORK_KIND" });
    expect(resolvePurpose(null, "NC_NET_HEAT")).toMatchObject({ value: "PRODUCTION", basis: "WORK_KIND" });
    expect(resolvePurpose(null, "CR_ROAD_ASPHALT")).toMatchObject({ value: "PRODUCTION" });
    expect(resolvePurpose(null, "CR_PROD_HOUSING")).toMatchObject({ value: "PRODUCTION" });
    expect(purposeOfWorkKind("NC_PUBLIC")).toBe("NON_PRODUCTION");
    expect(purposeOfWorkKind(null)).toBeNull();
  });

  it("вид работ не выбран — 2 % с допущением в надёжность; выбор пользователя главнее вида работ", () => {
    const byDefault = buildSsr(input());
    expect(byDefault.purpose.basis).toBe("DEFAULT");
    expect(byDefault.assumptions.find((item) => item.code === "PURPOSE_DEFAULT")?.affectsPrice).toBe(true);
    const byKind = buildSsr(input({ workKind: "CR_NET_WATER" }));
    expect(byKind.reserve.percent).toBe(3);
    expect(byKind.assumptions.find((item) => item.code === "PURPOSE_DEFAULT")).toBeUndefined();
    const byUser = buildSsr(input({ workKind: "CR_NET_WATER", purpose: "NON_PRODUCTION" }));
    expect(byUser.purpose.basis).toBe("USER");
    expect(byUser.reserve.percent).toBe(2);
  });
});

describe("допущения «Надёжности»", () => {
  it("без сроков индекс не применён, и это допущение, двигающее цену", () => {
    const result = buildSsr(input());
    const assumption = result.assumptions.find((item) => item.code === "PERIOD_UNKNOWN");
    expect(assumption?.affectsPrice).toBe(true);
    expect(assumption?.text).toContain("Прогнозная инфляция не применена");
  });

  it("со сроками допущение о соглашениях индекса не двигает цену", () => {
    const result = buildSsr(input({ period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } }));
    expect(result.assumptions.some((item) => item.code === "PERIOD_UNKNOWN")).toBe(false);
    expect(result.assumptions.find((item) => item.code === "INFLATION_CONVENTION")?.affectsPrice).toBe(false);
  });

  it("2030 год — индекс не рассчитан, допущение называет причину", () => {
    const result = buildSsr(input({ period: { kind: "DATES", start: "2029-10-01", end: "2030-03-31" } }));
    expect(result.assumptions.find((item) => item.code === "INFLATION_NOT_COMPUTED")?.text).toContain("нет дефлятора на 2030");
  });
});

describe("главы по разделам сметы", () => {
  it("раздел можно отнести к главе 6 (наружные сети); неверная глава — в главу 2", () => {
    const result = buildSsr(input({ sectionChapters: { Кровля: 6, Фасад: 12 } }));
    expect(result.chapters.find((chapter) => chapter.number === 6)?.amounts.total).toBe(500_000);
    expect(result.chapters.find((chapter) => chapter.number === 2)?.amounts.total).toBe(1_000_000);
    expect(result.chapters.find((chapter) => chapter.number === 12)?.computed).toBe(false);
  });
});

describe("пустая смета", () => {
  it("статус EMPTY, суммы нулевые", () => {
    const result = buildSsr(input({ document: ssrEstimate({ sections: [] }) }));
    expect(result.status).toBe("EMPTY");
    expect(result.nmc.total).toBe(0);
  });
});

describe("регресс: ССР — отдельный слой, смета не меняется", () => {
  it("документ сметы после построения ССР тот же, итоги прежние", () => {
    const document = ssrEstimate({ sections: TWO_SECTIONS, temporaryPercent: 2, winterPercent: 5 });
    const before = JSON.stringify(document);
    buildSsr({ ...input(), document, period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } });
    expect(JSON.stringify(document)).toBe(before);
    expect(document.totals.beforeVat).toBe(1_606_500);
    expect(document.totals.total).toBe(1_959_930);
  });

  it("локальный итог ССР без резерва равен итогу сметы до НДС", () => {
    const document = ssrEstimate({ sections: TWO_SECTIONS, temporaryPercent: 2, winterPercent: 5 });
    const result = buildSsr({ ...input(), document });
    expect(result.groups.find((group) => group.id === "1-12")?.amounts.total).toBe(document.totals.beforeVat);
  });
});

describe("пример закупки 0134300025826000377: НМЦК 2 032 153,32 ₽", () => {
  const nmc = 2_032_153.32;
  const doc = ssrEstimate({ sections: [{ title: "Ремонт теплоизоляции фасада", workCost: 1_625_720 }] });

  it("если наша смета равна ЛС заказчика (1 625 720 ₽), цена контракта по ССР сходится с НМЦК в пределах 0,05 %", () => {
    const result = buildSsr({
      document: doc,
      purpose: null,
      workKind: "CR_FACADE",
      period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" },
      priceDate: "2026-10-01",
      today: "2026-10-09",
    });
    const comparison = compareSsrWithNmc(result, nmc, true)!;
    expect(result.reserve.percent).toBe(2);
    expect(result.nmc.inflation.index).toBe(1.0047);
    expect(Math.abs(comparison.diffPercent)).toBeLessThan(0.05);
    expect(comparison.ours).toBeCloseTo(1_625_720 * 1.02 * 1.0047 * 1.22, 0);
    expect(plain(nmcHeadline(result, comparison))).toBe("Наша оценка НМЦК: 2 032 554 ₽ против НМЦК закупки 2 032 153 ₽ (с НДС; разница 0,0 %)");
  });

  it("с индексом заказчика 1,0045 цепочка даёт 2 032 149,67 ₽: от НМЦК остаётся 3,65 ₽ округления", () => {
    const chain = Math.round(1_625_720 * 1.02 * 100) / 100;
    const inflation = Math.round(chain * 0.0045 * 100) / 100;
    const vat = Math.round((chain + inflation) * 0.22 * 100) / 100;
    expect(chain).toBe(1_658_234.4);
    expect(inflation).toBe(7_462.05);
    expect(Math.round((chain + inflation + vat) * 100) / 100).toBe(2_032_149.67);
    expect(nmc - 2_032_149.67).toBeCloseTo(3.65, 2);
  });
});

describe("сравнение с НМЦК закупки", () => {
  const result = buildSsr(input({ period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } }));

  it("НМЦК с НДС сравнивается с оценкой с НДС, без НДС — без НДС", () => {
    const withVat = compareSsrWithNmc(result, 2_000_000, true)!;
    expect(withVat.ours).toBe(result.nmc.total);
    expect(withVat.diff).toBeCloseTo(result.nmc.total - 2_000_000, 2);
    const without = compareSsrWithNmc(result, 1_600_000, false)!;
    expect(without.ours).toBe(result.nmc.beforeVat);
    expect(without.diffPercent).toBeGreaterThan(0);
  });

  it("НМЦК не объявлена или смета пуста — сравнения нет", () => {
    expect(compareSsrWithNmc(result, null, true)).toBeNull();
    expect(compareSsrWithNmc(result, 0, true)).toBeNull();
    expect(compareSsrWithNmc(buildSsr(input({ document: ssrEstimate({ sections: [] }) })), 100, true)).toBeNull();
  });

  it("тексты: строка сравнения, индекс, проценты", () => {
    const comparison = compareSsrWithNmc(result, 2_000_000, true)!;
    expect(plain(nmcHeadline(result, comparison))).toContain("против НМЦК закупки 2 000 000 ₽");
    expect(plain(nmcHeadline(result, null))).toContain("НМЦК закупки не объявлена");
    expect(inflationLine(result)).toContain("Индекс прогнозной инфляции 1,0047 за период октябрь 2026 — ноябрь 2026");
    expect(inflationLine(buildSsr(input()))).toContain("Прогнозная инфляция не применена");
    expect(signedPercentText(-2.04)).toBe("−2,0 %");
    expect(signedPercentText(0.04)).toBe("0,0 %");
    expect(plain(rubText(2_032_153.32))).toBe("2 032 153 ₽");
  });
});
