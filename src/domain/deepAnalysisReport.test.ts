import { describe, expect, it } from "vitest";
import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import {
  buildDeepAnalysisReport,
  type ReportBlock,
} from "@/domain/deepAnalysisReport";
import { matchFindingsWithProfile } from "@/domain/profileMatch";
import { computeBidEconomics } from "@/domain/estimate/bidEconomics";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import { compareWithCustomerEstimate } from "@/domain/estimate/customerComparison";
import type { CustomerEstimate } from "@/domain/estimate/customerEstimate";
import { auditCustomerBim } from "@/domain/estimate/customerBimAudit";
import { reportLowCoverage, reportWithFindings } from "@/test/auditReports";
import { BELGOROD, CONTEXT, estimate, position } from "@/test/bimAuditFixtures";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { demoTenders } from "@/mocks/tenders";
import type { AnalysisFinding, DocumentMeta } from "@/types/database";

const tender = demoTenders[0]!;
const NOW = new Date("2026-10-05T12:00:00Z");

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "requirement",
    title: "Требование",
    detail: "Пояснение",
    evidence_quote: "цитата",
    evidence_section: "Извещение, п. 12",
    severity: "medium",
    ...patch,
  };
}

const FINDINGS: AnalysisFinding[] = [
  finding({ category: "risk", title: "Пеня 0,1%", severity: "low" }),
  finding({
    category: "blocker",
    title: "Лицензия ФСБ",
    requirement_kind: "LICENSE",
    required_value: "лицензия ФСБ на гостайну",
    severity: "high",
  }),
  finding({ category: "risk", title: "Односторонний отказ", severity: "high" }),
  finding({
    category: "blocker",
    title: "Лицензия МЧС",
    requirement_kind: "LICENSE",
    required_value: "лицензия МЧС на монтаж пожарной сигнализации",
    severity: "high",
  }),
  finding({
    category: "neutral",
    title: "Порядок рассмотрения заявок",
    detail: "в течение 3 дней",
  }),
];

function summary(over: Partial<DeepAnalysisSummary> = {}): DeepAnalysisSummary {
  return {
    state: "completed",
    title: "Разбор завершён",
    detail: "Прочитано 2 файла из 3.",
    job: null,
    documents: [
      {
        id: "1",
        filename: "Извещение.html",
        raw_json: { title: "Извещение", chars: 1000 },
      },
      {
        id: "2",
        filename: "ПСД.rar",
        raw_json: {
          skipped: { code: "empty_text", reason: "Скан без текстового слоя." },
        },
      },
    ] as unknown as DocumentMeta[],
    documentsWithText: 1,
    documentsSkipped: 1,
    documentsTruncated: 0,
    chunksAnalyzed: 2,
    findings: FINDINGS,
    findingGroups: [],
    modelUsed: "google/gemini-2.5-flash",
    verdictChange: null,
    ...over,
  } as DeepAnalysisSummary;
}

const titles = (r: ReturnType<typeof buildDeepAnalysisReport>) =>
  r.sections.map((s) => s.title);
const tableOf = (blocks: ReportBlock[]) => {
  const table = blocks.find((b) => b.kind === "table");
  if (!table || table.kind !== "table")
    throw new Error("в разделе нет таблицы");
  return table;
};

describe("buildDeepAnalysisReport: структура", () => {
  const report = buildDeepAnalysisReport({
    regNumber: tender.regNumber,
    subject: tender.subject,
    summary: summary(),
    generatedAt: NOW,
    tender,
    profileMatch: matchFindingsWithProfile(
      FINDINGS,
      tender,
      demoCompanyProfile,
      NOW,
    ),
  });

  it("разделы идут в порядке вопросов читателя; «Что сделать» и «Прочая информация» нет", () => {
    expect(titles(report)).toEqual([
      "Итог",
      "Можем ли участвовать",
      "Деньги",
      "Сроки и гарантия",
      "Смета и цена участия",
      "Риски договора",
      "Документы закупки",
      "Важно",
      "Прочие сведения из документации",
    ]);
    expect(titles(report)).not.toContain("Что сделать");
    expect(titles(report)).not.toContain("Прочая информация");
  });

  it("карточка закупки — заказчик, закон, цена, срок подачи; без модели и состояния разбора", () => {
    const labels = report.facts.map(([label]) => label);
    expect(labels).toEqual(
      expect.arrayContaining(["Заказчик", "Закон", "НМЦК", "Окончание подачи", "Отчёт сформирован"]),
    );
    expect(labels).not.toContain("Модель");
    expect(labels).not.toContain("Состояние разбора");
    // Номер и предмет — в заголовке отчёта, в таблице они повторялись бы.
    expect(labels).not.toContain("Закупка");
  });

  it("модель — мелко в «Важно»", () => {
    const blocks = report.sections.find((s) => s.title === "Важно")!.blocks;
    expect(blocks).toContainEqual({
      kind: "paragraph",
      text: "Разбор выполнен моделью google/gemini-2.5-flash.",
      small: true,
    });
  });

  it("итог начинается с ответа «можно ли участвовать», тоном результата", () => {
    const first = report.sections[0]!.blocks[0]!;
    expect(first).toMatchObject({ kind: "paragraph", tone: "bad", bold: true });
    expect(first.kind === "paragraph" && first.text).toMatch(/^Нет: не хватает нужной лицензии/);
  });

  it("таблица допуска — 5 колонок, невыполненное первым, основание с разделом", () => {
    const table = tableOf(report.sections[1]!.blocks);
    expect(table.columns.map((c) => c.title)).toEqual([
      "№",
      "Требование",
      "Статус",
      "Основание",
      "Что делать",
    ]);
    expect(table.columns.reduce((sum, c) => sum + c.width, 0)).toBe(100);
    expect(table.rows[0]![1]!.text).toMatch(/ФСБ/);
    expect(table.rows[0]![2]).toMatchObject({ text: "Не выполнено", tone: "bad" });
    expect(table.rows[1]![2]).toMatchObject({ text: "Выполнено", tone: "good" });
    expect(table.rows[0]![3]).toMatchObject({
      text: "«цитата»",
      note: "— Извещение, п. 12",
    });
    expect(table.rows[0]![4]!.text).toMatch(/Без этой лицензии заявку не примут/);
  });

  it("риски: высокие — строками, низкие — одной строкой в конце", () => {
    const blocks = report.sections[5]!.blocks;
    const table = tableOf(blocks);
    expect(table.columns.map((c) => c.title)).toEqual([
      "№",
      "Риск",
      "Важность",
      "Основание",
      "Что делать",
    ]);
    expect(table.rows.map((r) => r[1]!.text)).toEqual(["Односторонний отказ"]);
    expect(blocks.at(-1)).toMatchObject({
      kind: "paragraph",
      text: "Ещё 1 условие низкой важности: Пеня 0,1%.",
    });
  });

  it("главные действия — в «Итоге», а не отдельным разделом", () => {
    const block = report.sections[0]!.blocks.find((b) => b.kind === "bullets");
    if (!block || block.kind !== "bullets") throw new Error("ожидался список");
    expect(block.items.length).toBeLessThanOrEqual(3);
    expect(block.items.some((i) => /Без этой лицензии/.test(i))).toBe(true);
    expect(block.items.some((i) => /Односторонний отказ/.test(i))).toBe(true);
    expect(block.items.some((i) => /сжатый/.test(i))).toBe(true);
    // Непрочитанные файлы названы в «Итоге» отдельной строкой — с причиной простыми словами.
    expect(JSON.stringify(report.sections[0])).toMatch(
      /Прочитано 1 из 2 файлов\. Не прочитаны: «ПСД\.rar» — в файле нет текста/,
    );
  });

  it("документы — «Прочитано N из M» и таблица только пропущенных, простыми словами", () => {
    const blocks = report.sections[6]!.blocks;
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "Прочитано 1 из 2" });
    const table = tableOf(blocks);
    expect(table.columns.map((c) => c.title)).toEqual([
      "Файл",
      "Почему не прочитан",
      "Что делать",
    ]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]![0]!.text).toBe("ПСД.rar");
    expect(table.rows[0]![1]!.text).toMatch(/нет текста/);
    expect(table.rows[0]![2]!.text).toMatch(/Откройте файл вручную/);
  });
});

describe("buildDeepAnalysisReport: причины пропуска после снятия пределов", () => {
  const withSkips = () =>
    buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary({
        documents: [
          { id: "1", filename: "Извещение.html", raw_json: { chars: 1000 } },
          {
            id: "2",
            filename: "Старый.docx",
            raw_json: { skipped: { code: "over_char_budget", reason: "Не влез в бюджет 1 000 000 знаков." } },
          },
          {
            id: "3",
            filename: "Огромный.zip",
            raw_json: { skipped: { code: "file_too_large", reason: "Файл больше предела 300 МБ и не читается." } },
          },
        ] as unknown as DocumentMeta[],
        documentsSkipped: 2,
      }),
      generatedAt: NOW,
      tender,
      profileMatch: matchFindingsWithProfile(FINDINGS, tender, demoCompanyProfile, NOW),
    });

  it("«не влез в бюджет» описан как старая запись, а не как действующее правило", () => {
    const table = tableOf(withSkips().sections[6]!.blocks);
    const old = table.rows.find((row) => row[0]!.text === "Старый.docx")!;
    expect(old[1]!.text).toMatch(/прежнем ограничении.*снято/);
    expect(JSON.stringify(withSkips())).not.toMatch(/бюджет знаков|за один разбор/);
  });

  it("слишком большой файл называет действующие пределы", () => {
    const table = tableOf(withSkips().sections[6]!.blocks);
    const big = table.rows.find((row) => row[0]!.text === "Огромный.zip")!;
    expect(big[1]!.text).toMatch(/300 МБ.*2 ГБ/);
  });
});

describe("buildDeepAnalysisReport: без профиля и без находок", () => {
  it("без профиля — та же таблица со статусом «Проверить» и приглашением заполнить профиль", () => {
    const report = buildDeepAnalysisReport({
      regNumber: "1",
      subject: "Поставка",
      summary: summary(),
      generatedAt: NOW,
    });
    expect(titles(report)[1]).toBe("Можем ли участвовать");
    const blocks = report.sections[1]!.blocks;
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      text: "Заполните профиль компании — отчёт сам отметит, что выполнено.",
    });
    const table = tableOf(blocks);
    expect(table.columns).toHaveLength(5);
    expect(table.rows.map((r) => r[2]!.text)).toEqual(["Проверить", "Проверить"]);
    // «Что делать» — что нужно иметь, а не «автоматически не сверяется».
    expect(table.rows[0]![4]!.text).toMatch(/лицензия/);
    expect(JSON.stringify(report)).not.toMatch(/Автоматически не сверяется/);
  });

  it("пустой разбор всё равно даёт полный отчёт без пустых таблиц", () => {
    const report = buildDeepAnalysisReport({
      regNumber: "1",
      subject: "Поставка",
      summary: summary({
        findings: [],
        documents: [],
        documentsWithText: 0,
        documentsSkipped: 0,
      }),
      generatedAt: NOW,
      profileMatch: matchFindingsWithProfile(
        [],
        tender,
        demoCompanyProfile,
        NOW,
      ),
    });
    expect(titles(report)).not.toContain("Прочие сведения из документации");
    for (const section of report.sections) {
      for (const block of section.blocks) {
        if (block.kind === "table")
          expect(block.rows.length).toBeGreaterThan(0);
      }
    }
  });
});

/*
  Смета и цена участия. Первичный разбор говорит, можно ли участвовать; раздел
  отвечает, выгодно ли и до какой цены. Без сметы отчёт говорит об этом прямо.
*/
describe("buildDeepAnalysisReport: смета и цена участия", () => {
  const sectionOf = (report: ReturnType<typeof buildDeepAnalysisReport>) =>
    report.sections.find((section) => section.title === "Смета и цена участия");

  it("без сметы раздел есть и предлагает её рассчитать", () => {
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
    });

    const section = sectionOf(report);
    expect(section).toBeDefined();
    expect(JSON.stringify(section)).toMatch(/Рассчитать смету/);
    // После допуска, денег и сроков: «можно ли» → «выгодно ли».
    expect(report.sections[4]?.title).toBe("Смета и цена участия");
  });

  it("со сметой — минимальная цена, допустимое снижение и таблица цен", () => {
    const document = {
      parameters: { vatPercent: 20 },
      sections: [{ lines: [{ materialCost: 1_500_000 }] }],
      totals: {
        directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
        workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 800_000, total: 4_800_000,
      },
    } as unknown as EstimateDocument;
    const bidEconomics = computeBidEconomics({
      document,
      nmc: 5_400_000,
      billItems: 10,
      droppedPositions: 0,
      assumedPercent: 0,
      unpricedResources: 0,
      company: { taxSystem: "OSNO", minMarginPercent: 10 },
    });

    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      bidEconomics,
      estimateSource: { priceZone: "Республика Бурятия (1 зона)", period: "3 квартал 2026 г.", baseEdition: "ФСНБ-2022" },
    });

    const text = JSON.stringify(sectionOf(report));
    expect(text).toMatch(/Минимальная цена/);
    expect(text).toMatch(/4\s937\s1\d\d ₽/);
    expect(text).toMatch(/Допустимое снижение/);
    expect(text).toMatch(/8,6 %/);
    expect(text).toMatch(/Республика Бурятия \(1 зона\)/);
    const tables = sectionOf(report)!.blocks.filter((block) => block.kind === "table");
    expect(tables).toHaveLength(2);
  });
});

describe("buildDeepAnalysisReport: источник объёмов в разделе «Смета и цена участия»", () => {
  const document = {
    parameters: { vatPercent: 20 },
    sections: [{ lines: [{ materialCost: 1_500_000 }] }],
    totals: {
      directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
      workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 800_000, total: 4_800_000,
    },
  } as unknown as EstimateDocument;

  function section(extra: Partial<Parameters<typeof buildDeepAnalysisReport>[0]>) {
    const bidEconomics = computeBidEconomics({
      document,
      nmc: 5_400_000,
      billItems: 10,
      droppedPositions: 0,
      assumedPercent: 0,
      unpricedResources: 0,
      company: { taxSystem: "OSNO", minMarginPercent: 10 },
    });
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      bidEconomics,
      ...extra,
    });
    return report.sections.find((candidate) => candidate.title === "Смета и цена участия")!;
  }

  it("смета заказчика вместо ведомости: строка «Объёмы взяты из» и пояснение", () => {
    const text = JSON.stringify(
      section({
        volumeSource: {
          level: "CUSTOMER_ESTIMATE",
          documents: ["7. смета снос Мелихова 4.pdf"],
          note: "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «7. смета снос Мелихова 4.pdf»",
        },
      }),
    );

    expect(text).toContain("Объёмы взяты из: сметы заказчика «7. смета снос Мелихова 4.pdf»");
    expect(text).toContain("Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика");
  });

  it("ведомость: одна строка без пояснения", () => {
    const text = JSON.stringify(
      section({
        volumeSource: { level: "BILL", documents: ["ВОР.xlsx"], note: "Объёмы взяты из ведомости объёмов работ «ВОР.xlsx»" },
      }),
    );

    expect(text).toContain("Объёмы взяты из: ведомости объёмов работ «ВОР.xlsx»");
    expect(text.match(/Объёмы взяты из/g)).toHaveLength(1);
  });

  it("расхождения объёмов с оговоркой, что на сумму они не влияют", () => {
    const text = JSON.stringify(
      section({
        volumeFindings: [
          {
            workName: "Разборка зданий",
            billQuantity: 600,
            billUnit: "м3",
            customerQuantity: 581.63,
            customerUnit: "м3",
            diffPercent: 3.2,
            customerDocument: null,
            message: "В ведомости 600 м3, в смете заказчика 581,63 м3 — «Разборка зданий», расхождение 3,2 %",
          },
        ],
      }),
    );

    expect(text).toContain("Объёмы ведомости расходятся со сметой заказчика (на сумму расчёта не влияет): 1");
    expect(text).toContain("В ведомости 600 м3, в смете заказчика 581,63 м3");
  });

  it("работы ведомости, которых нет в смете заказчика, — отдельным пунктом", () => {
    const text = JSON.stringify(
      section({
        volumeFindings: [
          {
            kind: "BILL_ONLY",
            workName: "Окраска",
            billQuantity: 40,
            billUnit: "м2",
            customerQuantity: 0,
            customerUnit: "",
            diffPercent: 100,
            customerDocument: null,
            message: "Работа есть в ведомости, но нет в смете заказчика: «Окраска», 40 м2 — проверьте",
          },
        ],
      }),
    );

    expect(text).toContain("Работы ведомости, которых нет в смете заказчика");
    expect(text).toContain("Работа есть в ведомости, но нет в смете заказчика: «Окраска»");
    expect(text).not.toContain("Объёмы ведомости расходятся");
  });

  it("доля по ценам заказчика — строка в таблице показателей с оговоркой", () => {
    const text = JSON.stringify(section({ customerPriced: { amount: 803_943.09, count: 5 } }));

    expect(text).toContain("в т.ч. по ценам заказчика");
    expect(text).toContain("5 поз.");
    expect(text).toContain("не проверена нашими ценами");
  });

  it("без позиций по ценам заказчика строки нет", () => {
    expect(JSON.stringify(section({}))).not.toContain("в т.ч. по ценам заказчика");
  });

  it("расчёт без источника (до приоритета источников) строки не получает", () => {
    expect(JSON.stringify(section({}))).not.toContain("Объёмы взяты из");
  });
});

describe("buildDeepAnalysisReport: цена участия — запас прочности, НДС, антидемпинг", () => {
  const document = {
    parameters: { vatPercent: 20 },
    sections: [{ lines: [{ materialCost: 1_500_000 }] }],
    totals: {
      directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
      workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 800_000, total: 4_800_000,
    },
  } as unknown as EstimateDocument;

  function economicsSection(
    patch: Partial<Parameters<typeof computeBidEconomics>[0]> = {},
    vatStatus?: VatStatus | null,
  ) {
    const bidEconomics = computeBidEconomics({
      document,
      nmc: 5_400_000,
      billItems: 10,
      droppedPositions: 0,
      assumedPercent: 0,
      unpricedResources: 0,
      company: { taxSystem: "OSNO", minMarginPercent: 10 },
      ...patch,
    });
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      bidEconomics,
      vatStatus,
    });
    return report.sections.find((section) => section.title === "Смета и цена участия")!;
  }

  it("запас прочности — строкой в таблице показателей; «Доверие» стало «Надёжностью»", () => {
    const text = JSON.stringify(economicsSection());

    expect(text).toContain("Запас прочности при НМЦК");
    expect(text).toContain("+25,0 %");
    expect(text).toContain("до нулевой прибыли");
    expect(text).toContain("Надёжность расчёта");
    expect(text).not.toContain("Доверие");
  });

  it("НДС из документации: основание с цитатой и файлом", () => {
    const text = JSON.stringify(
      economicsSection(
        { nmcIncludesVat: false },
        { includesVat: false, basis: "DOCUMENT", quote: "цена контракта без НДС", documentName: "Извещение.docx", conflict: false },
      ),
    );

    expect(text).toContain("НДС в цене");
    expect(text).toContain("без НДС");
    expect(text).toContain("из документации: «цена контракта без НДС» (Извещение.docx)");
  });

  it("НДС по 44-ФЗ — допущение; допущение — предупреждение; конфликт — проверить вручную", () => {
    const law = JSON.stringify(economicsSection({}, { includesVat: true, basis: "LAW_44", quote: null, documentName: null, conflict: false }));
    expect(law).toContain("по 44-ФЗ цена контракта включает налоги — допущение, в документации прямо не указано");

    const assumed = JSON.stringify(economicsSection({}, { includesVat: true, basis: "ASSUMPTION", quote: null, documentName: null, conflict: false }));
    expect(assumed).toContain("НДС в документации не определён, принято «с НДС» — проверьте");

    const conflict = JSON.stringify(economicsSection({}, { includesVat: true, basis: "ASSUMPTION", quote: null, documentName: null, conflict: true }));
    expect(conflict).toContain("в документации встречаются оба варианта — проверьте вручную");
  });

  it("статус НДС не передан — строка есть, но говорит, что основание не определялось", () => {
    expect(JSON.stringify(economicsSection())).toContain("основание не определялось");
  });

  it("44-ФЗ: ячейка вердикта строк со снижением от 25 % помечена антидемпингом", () => {
    const section = economicsSection({ law: "FZ_44" });
    const priceTable = section.blocks.filter((block) => block.kind === "table")[1]!;
    if (priceTable.kind !== "table") throw new Error("ожидалась таблица");
    const marked = priceTable.rows.filter((row) => row[4]?.note?.includes("антидемпинг"));

    expect(marked).toHaveLength(2);
    // Допустимое снижение при НМЦК 5,4 млн меньше 25 % — общей пометки нет.
    expect(JSON.stringify(section)).not.toContain("По 44-ФЗ (ст. 37) при снижении цены на 25 % и более");
  });

  it("44-ФЗ и допустимое снижение от 25 %: общая пометка про обеспечение попадает в отчёт", () => {
    const section = economicsSection({ law: "FZ_44", nmc: 7_200_000 });
    expect(JSON.stringify(section)).toContain("По 44-ФЗ (ст. 37) при снижении цены на 25 % и более");
  });

  it("не 44-ФЗ: пометок антидемпинга нет", () => {
    expect(JSON.stringify(economicsSection({ law: "FZ_223" }))).not.toContain("антидемпинг");
  });
});

describe("buildDeepAnalysisReport: сравнение со сметой заказчика", () => {
  const document = {
    parameters: { vatPercent: 22 },
    sections: [
      {
        lines: [
          { materialCost: 0, directCost: 3_000_000, overheadCost: 600_000, profitCost: 400_000, billSection: "Монтаж" },
        ],
      },
    ],
    totals: {
      directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
      workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 880_000, total: 4_880_000,
    },
    gaps: [],
  } as unknown as EstimateDocument;

  const customer: CustomerEstimate = {
    documentName: "ЛСР.xlsx",
    estimateName: "лист 1",
    sections: [
      { number: "1", title: "Монтаж", amount: 3_000_000, quote: "" },
      { number: "2", title: "Оборудование", amount: 500_000, quote: "" },
    ],
    sectionsTotal: 3_500_000,
    statedTotal: 4_270_000,
    totalIncludesVat: true,
    checked: true,
    priceLevel: { zone: 1, quarter: 3, year: 2026 },
    method: "RESOURCE_2022",
  };

  function sectionFor(customerComparison: ReturnType<typeof compareWithCustomerEstimate> | null | undefined) {
    const bidEconomics = computeBidEconomics({
      document,
      nmc: 5_400_000,
      billItems: 10,
      droppedPositions: 0,
      assumedPercent: 0,
      unpricedResources: 0,
      company: { taxSystem: "OSNO", minMarginPercent: 10 },
    });
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      bidEconomics,
      customerComparison,
    });
    return report.sections.find((section) => section.title === "Смета и цена участия")!;
  }

  it("нет сравнения — подраздела нет", () => {
    expect(JSON.stringify(sectionFor(undefined))).not.toContain("Сравнение со сметой заказчика");
    expect(JSON.stringify(sectionFor(null))).not.toContain("Сравнение со сметой заказчика");
  });

  it("есть сравнение — таблица по разделам, строка сверки и источник", () => {
    const section = sectionFor(compareWithCustomerEstimate(document, [customer]));
    const text = JSON.stringify(section);

    expect(text).toContain("Сравнение со сметой заказчика");
    expect(text).toContain("ЛСР.xlsx · лист 1");
    expect(text).toContain("уровень цен заказчика: 1 зона, 3 кв. 2026");
    expect(text).toContain("✓ сумма разделов сходится с итогом сметы (итог указан с НДС)");

    const tables = section.blocks.filter((block) => block.kind === "table");
    const comparisonTable = tables[tables.length - 1]!;
    if (comparisonTable.kind !== "table") throw new Error("ожидалась таблица");
    // Монтаж: у нас 4 000 000 против 3 000 000 у заказчика (+33,3 %); «Оборудование» у нас нет.
    expect(comparisonTable.rows[0]!.map((cell) => cell.text.replace(/\s/g, " "))).toEqual([
      "Монтаж",
      "3 000 000 ₽",
      "4 000 000 ₽",
      "+1 000 000 ₽",
      "+33,3 %",
      "заказчик заложил меньше текущих цен — риск",
    ]);
    expect(comparisonTable.rows[1]![5]!.text).toBe("у нас нет позиций этого раздела");
    expect(text).toContain("Итого по сопоставленным разделам");
    expect(text.replace(/\s/g, " ")).toContain("Разделы заказчика без наших позиций: Оборудование (500 000 ₽).");
  });

  it("несошедшаяся сверка — предупреждение в отчёте", () => {
    const text = JSON.stringify(sectionFor(compareWithCustomerEstimate(document, [{ ...customer, checked: false }])));
    expect(text).toContain("⚠ итог сметы не сошёлся с разделами");
  });

  it("итога в тексте нет — в отчёте «не найден», а не «не сошёлся»; разные причины — обе строки", () => {
    const missing = { ...customer, checked: false, statedTotal: null, totalIncludesVat: null };
    const only = JSON.stringify(sectionFor(compareWithCustomerEstimate(document, [missing])));
    expect(only).toContain("⚠ итог сметы в тексте не найден (документ мог быть обрезан) — суммы разделов не сверены");
    expect(only).not.toContain("не сошёлся");

    const both = JSON.stringify(
      sectionFor(compareWithCustomerEstimate(document, [{ ...customer, checked: false }, { ...missing, documentName: "Б.xlsx" }])),
    );
    expect(both).toContain("итог сметы не сошёлся с разделами");
    expect(both).toContain("итог сметы в тексте не найден");
  });

  it("смета заказчика не найдена и смета в базисных ценах объяснены словами", () => {
    expect(JSON.stringify(sectionFor(compareWithCustomerEstimate(document, [])))).toContain(
      "Смета заказчика в документации не найдена — сравнивать не с чем.",
    );
    expect(
      JSON.stringify(sectionFor(compareWithCustomerEstimate(document, [{ ...customer, method: "BASE_2001" }]))),
    ).toContain("в базисных ценах 2001 г. или по территориальной базе (ТЕР/ФЕР/ТСН)");
  });

  it("несколько ЛСР: таблица «у заказчика / у нас / разница / %» по каждой смете и итог по сметам", () => {
    const lsrs = [
      { key: "02-02-07", number: "02-02-07", title: "Внутренние сети", sectionTitle: "ЛСР 02-02-07. Внутренние сети", documentName: "Описание объекта закупки", documents: ["Обоснование НМЦК", "Описание объекта закупки"], totalWithVat: 175_448.79, totalExVat: 143_810.48, sharedNumber: false, positions: 15, subPositions: 7 },
      { key: "02-02-08", number: "02-02-08", title: "Вентиляция", sectionTitle: "ЛСР 02-02-08. Вентиляция", documentName: "Описание объекта закупки", documents: ["Описание объекта закупки"], totalWithVat: 1_135_429.59, totalExVat: 930_679.99, sharedNumber: false, positions: 13, subPositions: 14 },
    ];
    const lsrDocument = {
      ...document,
      sections: [
        { title: lsrs[0]!.sectionTitle, workCost: 146_013.54, lines: new Array(22).fill({ directCost: 0 }) },
        { title: lsrs[1]!.sectionTitle, workCost: 898_163.19, lines: new Array(27).fill({ directCost: 0 }) },
      ],
    } as unknown as EstimateDocument;

    const comparison = compareWithCustomerEstimate(lsrDocument, [customer], lsrs);
    const section = sectionFor(comparison);
    const text = JSON.stringify(section);
    expect(text).toContain("По каждой локальной смете заказчика (без НДС)");

    const table = section.blocks.filter((block) => block.kind === "table").pop()!;
    if (table.kind !== "table") throw new Error("ожидалась таблица");
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]!.map((cell) => cell.text.replace(/\s/g, " "))).toEqual([
      "ЛСР 02-02-07. Внутренние сети",
      "143 810 ₽",
      "146 014 ₽",
      "+2 203 ₽",
      "+1,5 %",
      "близко",
    ]);
    expect(table.rows[0]![5]!.note).toContain("найдена в 2 документах, взята из «Описание объекта закупки»");
    expect(table.rows[1]![4]!.text).toBe("−3,5 %");
    expect(table.rows[2]![0]!.text).toBe("Итого по сметам");
  });

  it("много смет: первые 5 и «и ещё N», базисные — одной строкой", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...customer,
      documentName: `Смета ${String(index + 1)}.xlsx`,
      estimateName: null,
    }));
    const base = Array.from({ length: 4 }, (_, index) => ({
      ...customer,
      documentName: `Базисная ${String(index + 1)}.xlsx`,
      method: "BASE_2001" as const,
    }));
    const text = JSON.stringify(sectionFor(compareWithCustomerEstimate(document, [...many, ...base])));

    expect(text).toContain("Смета 5.xlsx");
    expect(text).not.toContain("Смета 6.xlsx");
    expect(text).toContain("и ещё 2");
    expect(text).toContain("Не сравниваются (базисные цены): 4");
    expect(text).not.toContain("Базисная 1.xlsx");
  });

  it("расчёт без разделов в документах: только итоги", () => {
    const noSections = {
      ...document,
      sections: [{ lines: [{ directCost: 1, overheadCost: 0, profitCost: 0, billSection: null }] }],
    } as unknown as EstimateDocument;
    const text = JSON.stringify(sectionFor(compareWithCustomerEstimate(noSections, [customer])));

    expect(text).toContain("В документах, по которым считались объёмы, разделов нет — сравниваем только итоги.");
    expect(text).toContain("Сумма разделов заказчика");
  });
});

describe("buildDeepAnalysisReport: аудит сметы заказчика", () => {
  function sectionWith(customerAudit: Parameters<typeof buildDeepAnalysisReport>[0]["customerAudit"]) {
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      customerAudit,
    });
    return report.sections.find((section) => section.title === "Смета и цена участия")!;
  }

  const input = (reports: ReturnType<typeof reportWithFindings>[], notRecognized: { documentName: string; estimateName: string | null; reason: string }[] = []) => ({
    reports,
    zone: { zoneName: "Республика Бурятия (5 зона)" },
    period: "3 квартал 2026 г.",
    notRecognized,
  });

  it("аудита не запускали — подраздела нет", () => {
    expect(JSON.stringify(sectionWith(undefined))).not.toContain("Аудит сметы заказчика");
    expect(JSON.stringify(sectionWith(null))).not.toContain("Аудит сметы заказчика");
  });

  it("есть аудит — шапка с выводом, «откуда разница», таблица топа и пояснение «без ИИ»", () => {
    const audit = reportWithFindings();
    const section = sectionWith(input([audit]));
    const text = JSON.stringify(section).replace(/\s/g, " ");

    expect(text).toContain("Аудит сметы заказчика");
    expect(text).toContain("Проверка без ИИ по ценам зоны «Республика Бурятия, 5 зона, 3 кв. 2026»");
    expect(text).toContain(audit.conclusion.replace(/\s/g, " "));
    expect(text).toContain("Откуда разница:");
    expect(text).toContain("Труд (с НР и СП на него): +");
    expect(text).toContain("проверено 100 % прямых затрат");

    const table = section.blocks.filter((block) => block.kind === "table").at(-1)!;
    if (table.kind !== "table") throw new Error("ожидалась таблица");
    expect(table.columns.map((column) => column.title)).toEqual(["№", "Обоснование", "Наименование", "У заказчика", "У нас", "Разница"]);
    expect(table.rows).toHaveLength(Math.min(10, audit.top.length));
    expect(table.rows[0]![1]!.text).toBe("ГЭСНр56-01-009-01");
  });

  it("покрытие ниже 70 % — предупреждающая строка и оговорка в выводе; нераспознанные сметы названы", () => {
    const section = sectionWith(
      input([reportLowCoverage()], [{ documentName: "Изыскания.xlsx", estimateName: null, reason: "это не форма 421/пр" }]),
    );
    const text = JSON.stringify(section);
    expect(text).toContain("вывод неполный");
    const coverage = section.blocks.find((block) => block.kind === "paragraph" && block.text.startsWith("проверено"));
    expect(coverage).toMatchObject({ tone: "warn" });
    expect(text).toContain("Смета «Изыскания.xlsx» — не форма 421/пр, построчно не проверена");
  });
});

describe("buildDeepAnalysisReport: метод БИМ", () => {
  const sectionOf = (report: ReturnType<typeof buildDeepAnalysisReport>) => report.sections.find((section) => section.title === "Смета и цена участия");
  const document = {
    parameters: { vatPercent: 20 },
    sections: [{ lines: [{ materialCost: 1_500_000 }] }],
    totals: {
      directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
      workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 800_000, total: 4_800_000,
    },
  } as unknown as EstimateDocument;
  const bidEconomics = computeBidEconomics({
    document,
    nmc: 5_400_000,
    billItems: 10,
    droppedPositions: 0,
    assumedPercent: 0,
    unpricedResources: 0,
    company: { taxSystem: "OSNO", minMarginPercent: 10 },
  });
  const bim = {
    basis: "CUSTOMER" as const,
    basisNote: "смета заказчика на ФЕР",
    subject: "Белгородская область",
    zone: null,
    quarter: "III кв. 2026",
    object: "Многоквартирные жилые дома: Кирпичные",
    objectDetected: true,
    customerBase: "TER" as const,
    indexLabour: 47.58,
    indexMachines: 15.15,
    indexMaterials: 9.58,
    letter: "письмо Минстроя России от 30.07.2026 № 46728-ИФ/09, стр. 1",
  };

  it("смета БИМ: метод, индексы письма, объект и оговорка про ТЕР — теми же словами, что на экране", () => {
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      bidEconomics,
      estimateSource: { priceZone: "Белгородская область", period: "III кв. 2026 (индексы Минстроя)", baseEdition: "ФСНБ-2020", method: "BASE_INDEX", bim },
    });
    const text = JSON.stringify(sectionOf(report)).replace(/\s/g, " ");
    expect(text).toContain("Метод: базисно-индексный (ФЕР-2001 × индексы) — как у заказчика (смета заказчика на ФЕР)");
    expect(text).toContain("ОЗП 47,58, ЭМ 15,15, материалы 9,58");
    expect(text).toContain("ТЕР Белгородская область недоступны в открытых данных — посчитано по ФЕР с индексами к ФЕР; возможна разница");
    expect(text).not.toContain("Расчёт ресурсно-индексным методом");
  });

  it("ресурсная смета подписана прежней строкой", () => {
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      bidEconomics,
      estimateSource: { priceZone: "Республика Бурятия (1 зона)", period: "3 квартал 2026 г.", baseEdition: "ФСНБ-2022", method: "RESOURCE_INDEX" },
    });
    expect(JSON.stringify(sectionOf(report))).toContain("Расчёт ресурсно-индексным методом: ФСНБ-2022");
  });

  it("аудит сметы БИМ: шапка, индексы по письму текстом задания и что проверено", () => {
    const audit = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })] }), CONTEXT);
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
      customerAudit: { reports: [audit], zone: { zoneName: "Белгородская область" }, period: "III кв. 2026", notRecognized: [] },
    });
    const text = JSON.stringify(report.sections.find((section) => section.title === "Смета и цена участия")).replace(/\s/g, " ");
    expect(text).toContain("Смета составлена базисно-индексным методом");
    expect(text).toContain("Смета заказчика (базисно-индексный метод)");
    expect(text).toContain("Заказчик применил индекс к ОЗП 45,00, по письму письмо Минстроя России от 30.07.2026 № 46728-ИФ/09");
    expect(text).toContain("Из них индексы (письмо Минстроя): +");
    expect(text).toContain("Базисные цены расценок: сверено с ФЕР-2020 1 (совпало 1, расходится 0)");
  });
});

describe("buildDeepAnalysisReport: сводка и деньги", () => {
  it("противоречия и вопросы заказчику — отдельным разделом сразу после заключения; запас по цене — в «Деньгах»", () => {
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary({
        consolidation: {
          kind: "consolidated",
          summary: "Участвовать можно, главный риск — сроки.",
          findings: [],
          conflicts: [
            {
              topic: "Срок выполнения",
              values: [
                { value: "до 20.11.2026", source: "Проект контракта" },
                { value: "до 30.11.2026", source: "ТЗ" },
              ],
              resolution: "какой срок действует",
              needs_question: true,
            },
          ],
          questions: ["Уточните срок выполнения работ."],
          facts: {
            work_start: null,
            work_end: null,
            warranty_months: null,
            bid_security_percent: null,
            contract_security_percent: null,
            warranty_security_percent: null,
            advance_percent: null,
            payment_days: null,
          },
        },
      }),
      generatedAt: NOW,
      tender,
      moneyOutlook: {
        securities: [],
        frozenPeak: 1_000_000,
        advancePercent: null,
        paymentDays: null,
        margin: {
          profit: 60_000,
          overhead: 100_000,
          base: 1_000_000,
          scenarios: [{ reduction: 0.05, price: 950_000, profitLeft: 0.01, overheadLeft: 0.11, note: "остаётся сметной прибыли около 1,0 %" }],
        },
        winter: { months: ["ноябрь"], included: null },
      },
    });

    const names = titles(report);
    expect(names.indexOf("Противоречия и вопросы заказчику")).toBe(1);
    const consolidation = report.sections[1]!;
    expect(tableOf(consolidation.blocks).rows[0]![2]!.text).toMatch(/^Уточнить у заказчика/);
    const money = report.sections.find((s) => s.title === "Деньги")!;
    const text = JSON.stringify(money.blocks);
    expect(text).toContain("Одновременно может быть заморожено до 1");
    expect(text).toContain("остаётся сметной прибыли около 1,0 %");
    expect(text).toContain("Зимнее удорожание в смете заказчика не начислено");
  });

  it("без сводки раздела нет — отчёт как прежде", () => {
    const report = buildDeepAnalysisReport({
      regNumber: tender.regNumber,
      subject: tender.subject,
      summary: summary(),
      generatedAt: NOW,
      tender,
    });
    expect(titles(report)).not.toContain("Противоречия и вопросы заказчику");
  });
});
