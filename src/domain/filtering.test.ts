import { describe, expect, it } from "vitest";
import type {
  Tender,
  TenderDocument,
  TenderFinancialTerms,
  TenderLot,
} from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import {
  buildTextQuery,
  countRowsByLaw,
  defaultFilters,
  filterRows,
  paginate,
  searchRows,
  sortRows,
  sortSearched,
  type TenderFilters,
} from "@/domain/filtering";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { combineRelevanceAndFit } from "@/domain/searchRanking";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { pipelineRepository } from "@/repositories/pipelineRepository";

function buildRows(): TenderRow[] {
  return demoTenders.slice(0, 12).map((tender) => ({
    tender,
    analysis: analyzeTender(tender, demoCompanyProfile),
    pipelineStatus: pipelineRepository.getStatus(tender.id),
  }));
}

const rows = buildRows();

function withFilters(patch: Partial<TenderFilters>): TenderFilters {
  return { ...defaultFilters, ...patch };
}

/** Заготовка лота: в тестах поиска номенклатура важнее её окружения. */
function makeLot(patch: Partial<TenderLot> = {}): TenderLot {
  return {
    id: "lot-1",
    number: 1,
    subject: "",
    price: 0,
    okpd2Codes: [],
    deliveryRegion: "",
    deliveryAddress: "",
    deliveryTermDays: null,
    ...patch,
  };
}

/** Заготовка документа закупки. */
function makeDocument(patch: Partial<TenderDocument> = {}): TenderDocument {
  return {
    id: "doc-1",
    type: "OTHER",
    title: "",
    fileName: "",
    url: "",
    text: "",
    pageCount: null,
    lastModified: null,
    ...patch,
  };
}

/** Строка с изменённой закупкой — остальные поля берутся из демо-данных. */
function rowWith(patch: Partial<Tender>, base: TenderRow = rows[0]!): TenderRow {
  return { ...base, tender: { ...base.tender, ...patch } };
}

/** Строка с изменёнными финансовыми условиями. */
function rowWithFinancial(
  patch: Partial<TenderFinancialTerms>,
  base: TenderRow = rows[0]!,
): TenderRow {
  return rowWith(
    { financial: { ...base.tender.financial, ...patch } },
    base,
  );
}

describe("filterRows", () => {
  it("без фильтров возвращает все строки", () => {
    expect(filterRows(rows, defaultFilters)).toHaveLength(rows.length);
  });

  it("фильтр по вердикту оставляет только нужный вердикт", () => {
    const filtered = filterRows(rows, withFilters({ verdict: "RECOMMENDED" }));
    expect(filtered.length).toBeGreaterThan(0);
    for (const r of filtered) expect(r.analysis.verdict).toBe("RECOMMENDED");
  });

  it("фильтр по закону 44-ФЗ отсекает 223-ФЗ", () => {
    const filtered = filterRows(rows, withFilters({ laws: ["FZ_44"] }));
    for (const r of filtered) expect(r.tender.law).toBe("FZ_44");
  });

  it("фильтр по диапазону цены соблюдает границы", () => {
    const filtered = filterRows(
      rows,
      withFilters({ minPrice: 500_000, maxPrice: 3_000_000 }),
    );
    for (const r of filtered) {
      expect(r.tender.financial.price).toBeGreaterThanOrEqual(500_000);
      expect(r.tender.financial.price).toBeLessThanOrEqual(3_000_000);
    }
  });

  it("поиск по словам предмета находит закупку", () => {
    /*
      Берём первые два целых слова, а не первые десять знаков. Обрывок слова
      раньше проходил случайно: совпадения по любому слову запроса хватало.
      Теперь слова складываются по «и», и «Поставка к» значит «поставка» и
      «к» — запрос, которого никто не набирает.
    */
    const needle = rows[0]!.tender.subject.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
    const filtered = filterRows(rows, withFilters({ search: needle }));
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("фильтр hasHardBlockers=true оставляет только закупки с блокерами", () => {
    const filtered = filterRows(rows, withFilters({ hasHardBlockers: true }));
    for (const r of filtered) expect(r.analysis.hardBlockers.length).toBeGreaterThan(0);
  });

  it("фильтр по ИНН заказчика оставляет только его закупки", () => {
    const inn = rows[0]!.tender.customerInn!;
    const filtered = filterRows(rows, withFilters({ customerInn: inn }));
    expect(filtered.length).toBeGreaterThan(0);
    for (const r of filtered) expect(r.tender.customerInn).toBe(inn);
  });

  it("пробелы в ИНН заказчика игнорируются", () => {
    const inn = rows[0]!.tender.customerInn!;
    expect(filterRows(rows, withFilters({ customerInn: ` ${inn} ` }))).toHaveLength(
      filterRows(rows, withFilters({ customerInn: inn })).length,
    );
  });

  it("пустой ИНН заказчика не фильтрует выдачу", () => {
    expect(filterRows(rows, withFilters({ customerInn: "" }))).toHaveLength(rows.length);
  });

  it("несколько ИНН заказчика работают как OR", () => {
    const [first, second] = [rows[0]!.tender.customerInn!, rows[5]!.tender.customerInn!];
    expect(first).not.toBe(second);
    const filtered = filterRows(rows, withFilters({ customerInns: [first, second] }));
    expect(filtered.map((r) => r.tender.customerInn).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("основной ИНН и список ИНН объединяются", () => {
    const first = rows[0]!.tender.customerInn!;
    const second = rows[5]!.tender.customerInn!;
    const filtered = filterRows(
      rows,
      withFilters({ customerInn: first, customerInns: [second] }),
    );
    expect(filtered.map((r) => r.tender.customerInn).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("закупка без ИНН заказчика отсекается при фильтре по ИНН", () => {
    const withoutInn: TenderRow = {
      ...rows[0]!,
      tender: { ...rows[0]!.tender, customerInn: null },
    };
    const filtered = filterRows(
      [withoutInn],
      withFilters({ customerInn: "0000000001" }),
    );
    expect(filtered).toHaveLength(0);
  });

  it("фильтр по площадке-источнику оставляет только её закупки", () => {
    const source = rows[0]!.tender.dataSource;
    const filtered = filterRows(rows, withFilters({ sources: [source] }));
    expect(filtered.length).toBeGreaterThan(0);
    for (const r of filtered) expect(r.tender.dataSource).toBe(source);
  });

  it("пустой список источников не фильтрует выдачу", () => {
    expect(filterRows(rows, withFilters({ sources: [] }))).toHaveLength(rows.length);
  });

  it("несколько источников работают как OR", () => {
    const kontur: TenderRow = {
      ...rows[0]!,
      tender: { ...rows[0]!.tender, dataSource: "KONTUR" },
    };
    const imported: TenderRow = {
      ...rows[1]!,
      tender: { ...rows[1]!.tender, dataSource: "IMPORT" },
    };
    expect(
      filterRows([kontur, imported], withFilters({ sources: ["KONTUR", "IMPORT"] })),
    ).toHaveLength(2);
    const onlyKontur = filterRows([kontur, imported], withFilters({ sources: ["KONTUR"] }));
    expect(onlyKontur).toHaveLength(1);
    expect(onlyKontur[0]!.tender.dataSource).toBe("KONTUR");
  });

  it("набор фильтров из старого localStorage без полей ИНН не падает", () => {
    const legacy = { ...defaultFilters } as Partial<TenderFilters>;
    delete legacy.customerInn;
    delete legacy.customerInns;
    delete legacy.sources;
    const filtered = filterRows(rows, legacy as TenderFilters);
    expect(filtered).toHaveLength(rows.length);
  });
});

describe("countRowsByLaw", () => {
  it("без фильтров считает все закупки и раскладывает их по законам", () => {
    const counts = countRowsByLaw(rows, defaultFilters);

    expect(counts.ALL).toBe(rows.length);
    expect(counts.FZ_44).toBeGreaterThan(0);
    expect(counts.FZ_223).toBeGreaterThan(0);
    expect(counts.FZ_44 + counts.FZ_223 + counts.PP_RF_615 + counts.COMMERCIAL).toBe(counts.ALL);
  });

  it("уже выбранный закон не занижает счётчики остальных", () => {
    // Иначе переключатель показывал бы «223-ФЗ (0)» ровно тогда, когда пользователь
    // стоит на «44-ФЗ», — то есть в единственный момент, когда счётчик ему и нужен.
    const counts = countRowsByLaw(rows, withFilters({ laws: ["FZ_44"] }));

    expect(counts.FZ_223).toBeGreaterThan(0);
    expect(counts.ALL).toBe(rows.length);
  });

  it("остальные фильтры учитываются", () => {
    const counts = countRowsByLaw(rows, withFilters({ verdict: "RECOMMENDED" }));
    const expected = filterRows(rows, withFilters({ verdict: "RECOMMENDED", laws: [] }));

    expect(counts.ALL).toBe(expected.length);
    expect(counts.ALL).toBeLessThan(rows.length);
  });

  it("для отсутствующих в данных законов возвращает ноль, а не undefined", () => {
    const counts = countRowsByLaw(rows, defaultFilters);

    // Демо-данные содержат только 44-ФЗ и 223-ФЗ; UI рисует счётчик без «?? 0».
    expect(counts.PP_RF_615).toBe(0);
    expect(counts.COMMERCIAL).toBe(0);
  });

  it("пустая выдача даёт нули везде", () => {
    const counts = countRowsByLaw([], defaultFilters);

    expect(counts).toEqual({ ALL: 0, FZ_44: 0, FZ_223: 0, PP_RF_615: 0, COMMERCIAL: 0 });
  });
});

describe("sortRows", () => {
  it("сортировка по fitScore desc невозрастающая", () => {
    const sorted = sortRows(rows, "fitScore", "desc");
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i - 1]!.analysis.fitScore).toBeGreaterThanOrEqual(
        sorted[i]!.analysis.fitScore,
      );
    }
  });

  it("сортировка по цене asc неубывающая", () => {
    const sorted = sortRows(rows, "price", "asc");
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i - 1]!.tender.financial.price).toBeLessThanOrEqual(
        sorted[i]!.tender.financial.price,
      );
    }
  });

  it("не мутирует исходный массив", () => {
    const before = rows.map((r) => r.tender.id);
    sortRows(rows, "price", "asc");
    expect(rows.map((r) => r.tender.id)).toEqual(before);
  });
});

/* ====================== Свежесть + фит: порядок по умолчанию ====================== */

const NOW = new Date("2026-09-25T15:00:00.000Z");
const STAMP = "2026-09-25T14:52:03.000Z";
const OPEN_END = "2026-10-05T10:00:00.000Z";
const SOONER_END = "2026-09-28T10:00:00.000Z";
const EXPIRED_END = "2026-09-20T10:00:00.000Z";
const CTX = { batchStamp: STAMP, now: NOW };

/** Строка с нужными метками времени и заданным Fit Score. */
function freshRow(
  id: string,
  patch: Partial<Tender>,
  fitScore: number,
): TenderRow {
  const base = demoTenders[0]!;
  const tender: Tender = {
    ...base,
    id,
    deadlines: { ...base.deadlines, submissionEnd: OPEN_END },
    ...patch,
  };
  return {
    tender,
    analysis: { ...analyzeTender(tender, demoCompanyProfile), fitScore },
    pipelineStatus: "NEW",
  };
}

/** Строка партии последнего прогона Контур.Закупок. */
function batchRow(id: string, fitScore: number, patch: Partial<Tender> = {}) {
  return freshRow(
    id,
    { dataSource: "KONTUR", syncedAt: STAMP, firstSeenAt: STAMP, ...patch },
    fitScore,
  );
}

describe("сортировка «Свежесть + фит»", () => {
  it("порядок по умолчанию — Fit Score; свежесть выбирается явно", () => {
    // Выдача отобрана по словам, и внутри неё первыми идут закупки, которые
    // лучше всего подходят компании: первый слой находит, второй ранжирует.
    expect(defaultFilters.sortField).toBe("fitScore");
  });

  it("слои идут сверху вниз: последний прогон, неделя, раньше, истёкшие", () => {
    const input = [
      freshRow("EARLIER", { firstSeenAt: "2026-09-01T09:00:00.000Z" }, 95),
      batchRow("BATCH", 20),
      freshRow("EXPIRED", { deadlines: { ...demoTenders[0]!.deadlines, submissionEnd: EXPIRED_END }, firstSeenAt: STAMP }, 99),
      freshRow("WEEK", { firstSeenAt: "2026-09-22T09:00:00.000Z" }, 80),
    ];

    const ids = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);

    expect(ids).toEqual(["BATCH", "WEEK", "EARLIER", "EXPIRED"]);
  });

  it("высокий Fit Score не поднимает старую закупку над результатом последнего поиска", () => {
    const input = [
      freshRow("EARLIER", { firstSeenAt: "2026-09-01T09:00:00.000Z" }, 99),
      batchRow("BATCH", 21),
    ];

    const ids = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);

    expect(ids).toEqual(["BATCH", "EARLIER"]);
  });

  it("внутри слоя первая — закупка с большим Fit Score", () => {
    const input = [batchRow("LOW", 40), batchRow("HIGH", 90)];

    const ids = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);

    expect(ids).toEqual(["HIGH", "LOW"]);
  });

  it("при равном Fit Score выше ближайший срок подачи", () => {
    const input = [
      freshRow("LATER", { firstSeenAt: "2026-09-22T09:00:00.000Z", deadlines: { ...demoTenders[0]!.deadlines, submissionEnd: OPEN_END } }, 70),
      freshRow("SOONER", { firstSeenAt: "2026-09-22T09:00:00.000Z", deadlines: { ...demoTenders[0]!.deadlines, submissionEnd: SOONER_END } }, 70),
    ];

    const ids = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);

    expect(ids).toEqual(["SOONER", "LATER"]);
  });

  it("при равном Fit Score и сроке порядок устойчив — по предмету закупки", () => {
    const input = [
      freshRow("B", { subject: "b", firstSeenAt: "2026-09-22T09:00:00.000Z" }, 70),
      freshRow("A", { subject: "a", firstSeenAt: "2026-09-22T09:00:00.000Z" }, 70),
    ];

    const ids = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);

    expect(ids).toEqual(["A", "B"]);
  });

  it("направление asc переворачивает весь порядок", () => {
    const input = [
      freshRow("EARLIER", { firstSeenAt: "2026-09-01T09:00:00.000Z" }, 95),
      batchRow("BATCH", 20),
      freshRow("WEEK", { firstSeenAt: "2026-09-22T09:00:00.000Z" }, 80),
    ];

    const desc = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);
    const asc = sortRows(input, "freshness", "asc", CTX).map((r) => r.tender.id);

    expect(desc).toEqual(["BATCH", "WEEK", "EARLIER"]);
    expect(asc).toEqual([...desc].reverse());
  });

  it("без явного контекста партия выводится из переданных строк", () => {
    const input = [
      freshRow("EIS", { dataSource: "EIS", firstSeenAt: "2026-09-24T09:00:00.000Z" }, 90),
      batchRow("BATCH", 30),
    ];

    const ids = sortRows(input, "freshness", "desc").map((r) => r.tender.id);

    expect(ids).toEqual(["BATCH", "EIS"]);
  });

  it("sortSearched упорядочивает по свежести так же, как sortRows", () => {
    const input = [
      freshRow("EARLIER", { firstSeenAt: "2026-09-01T09:00:00.000Z" }, 95),
      batchRow("BATCH", 20),
      freshRow("WEEK", { firstSeenAt: "2026-09-22T09:00:00.000Z" }, 80),
    ];
    const hits = searchRows(input, withFilters({ sortField: "freshness" }));

    const bySearched = sortSearched(hits, "freshness", "desc", CTX).map(
      (h) => h.row.tender.id,
    );
    const byRows = sortRows(input, "freshness", "desc", CTX).map((r) => r.tender.id);

    expect(bySearched).toEqual(byRows);
  });
});

describe("paginate", () => {
  it("режет на страницы и считает totalPages", () => {
    const p = paginate(rows, 1, 5);
    expect(p.items).toHaveLength(5);
    expect(p.total).toBe(rows.length);
    expect(p.totalPages).toBe(Math.ceil(rows.length / 5));
  });

  it("страница вне диапазона корректируется к последней", () => {
    const p = paginate(rows, 999, 5);
    expect(p.page).toBe(p.totalPages);
    expect(p.items.length).toBeGreaterThan(0);
  });

  it("пустой список даёт одну пустую страницу", () => {
    const p = paginate([], 1, 10);
    expect(p.items).toHaveLength(0);
    expect(p.totalPages).toBe(1);
  });
});

/* ============================== Текстовый поиск ============================== */

describe("поиск в ленте", () => {
  it("пустая строка поиска и пустые исключения ничего не отсекают", () => {
    expect(
      filterRows(rows, withFilters({ search: "", excludeKeywords: [] })),
    ).toHaveLength(rows.length);
  });

  it("buildTextQuery возвращает null, когда искать нечего", () => {
    expect(buildTextQuery(withFilters({ search: "   " }))).toBeNull();
    expect(buildTextQuery(withFilters({ searchKeywords: [] }))).toBeNull();
  });

  it("ищет по основе, а не по дословной подстроке", () => {
    const row = rowWith({ subject: "Поставка вентилей для газовой системы" });
    expect(filterRows([row], withFilters({ search: "вентиля" }))).toHaveLength(1);
  });

  it("находит слово при недоборе последних букв", () => {
    const row = rowWith({ subject: "Вентиляционные системы" });
    expect(filterRows([row], withFilters({ search: "вент" }))).toHaveLength(1);
  });

  it("огрызок из двух букв не тянет в выдачу всё подряд", () => {
    const row = rowWith({ subject: "Оборудование" });
    expect(filterRows([row], withFilters({ search: "об" }))).toHaveLength(0);
  });

  it("ищет в номенклатуре лотов, а не только в предмете", () => {
    // Прежний поиск смотрел в subject/customerName/regNumber и терял закупку,
    // где нужная позиция названа только в спецификации.
    const row = rowWith({
      subject: "Поставка оборудования",
      lots: [makeLot({ id: "lot-search", subject: "Клапан запорный стальной" })],
    });
    expect(filterRows([row], withFilters({ search: "клапан" }))).toHaveLength(1);
    expect(filterRows([row], withFilters({ search: "запорный" }))).toHaveLength(1);
  });

  it("находит закупку по реестровому номеру", () => {
    const row = rowWith({
      subject: "Поставка вентилей",
      regNumber: "0345600001224000123",
    });
    expect(
      filterRows([row], withFilters({ search: "0345600001224000123" })),
    ).toHaveLength(1);
  });

  it("код ОКПД2 в строке поиска находит закупку по коду", () => {
    const row = rowWith({
      subject: "Поставка оборудования",
      okpd2Codes: ["30.01.24.190"],
    });
    expect(filterRows([row], withFilters({ search: "30.01" }))).toHaveLength(1);
    expect(filterRows([row], withFilters({ search: "36.40" }))).toHaveLength(0);
  });

  it("код ОКПД2 из дополнительных ключевых слов тоже работает", () => {
    // Профиль поиска подставляет коды отдельным списком; точка не должна
    // разбивать их на бессмысленные слова.
    const row = rowWith({
      subject: "Поставка оборудования",
      okpd2Codes: ["30.01.24.190"],
    });
    const query = buildTextQuery(
      withFilters({ searchKeywords: ["30.01.24.190"] }),
    );
    expect(query?.query.codes).toContain("30.01.24.190");
    expect(
      filterRows([row], withFilters({ searchKeywords: ["30.01"] })),
    ).toHaveLength(1);
  });

  it("минус перед словом исключает закупку", () => {
    const row = rowWith({ subject: "Аренда вентилей" });
    expect(filterRows([row], withFilters({ search: "вентиль -аренда" }))).toHaveLength(0);
    expect(filterRows([row], withFilters({ search: "вентиль" }))).toHaveLength(1);
  });

  it("поле исключений работает так же, как минус в строке", () => {
    const row = rowWith({ subject: "Аренда вентилей" });
    const filtered = filterRows(
      [row],
      withFilters({ search: "вентиль", excludeKeywords: ["аренда"] }),
    );
    expect(filtered).toHaveLength(0);
  });

  it("исключение не отсекает закупку, где слова нет", () => {
    const row = rowWith({ subject: "Поставка вентилей" });
    expect(
      filterRows(
        [row],
        withFilters({ search: "вентиль", excludeKeywords: ["аренда"] }),
      ),
    ).toHaveLength(1);
  });

  it("точное совпадение ищет дословную подстроку, а не основу", () => {
    const row = rowWith({ subject: "Вентили стальные" });
    // Нечёткий поиск видит в «вентиля» основу и находит «вентили»; дословный
    // ищет только подстроку, которой в этой словоформе нет.
    expect(filterRows([row], withFilters({ search: "вентиля" }))).toHaveLength(1);
    expect(
      filterRows([row], withFilters({ search: "вентиля", exactMatch: true })),
    ).toHaveLength(0);
    expect(
      filterRows([row], withFilters({ search: "ентил", exactMatch: true })),
    ).toHaveLength(1);
  });

  it("фраза в кавычках ищется дословно", () => {
    const together = rowWith({ subject: "Техническое обслуживание котлов" });
    const apart = rowWith(
      { subject: "Обслуживание котлов, работы технические" },
      rows[1]!,
    );
    const filters = withFilters({ search: '"техническое обслуживание"' });
    expect(filterRows([together, apart], filters)).toHaveLength(1);
  });

  it("области поиска ограничивают просмотр", () => {
    const row = rowWith({
      subject: "Поставка оборудования",
      lots: [makeLot({ id: "lot-scope", subject: "Клапан запорный" })],
    });
    expect(
      filterRows([row], withFilters({ search: "клапан", scopes: ["subject"] })),
    ).toHaveLength(0);
    expect(
      filterRows([row], withFilters({ search: "клапан", scopes: ["items"] })),
    ).toHaveLength(1);
    // Пустой список областей означает «все».
    expect(
      filterRows([row], withFilters({ search: "клапан", scopes: [] })),
    ).toHaveLength(1);
  });

  it("поиск объясняет, в каких областях нашлось совпадение", () => {
    const row = rowWith({ subject: "Поставка вентилей" });
    const hits = searchRows([row], withFilters({ search: "вентиль" }));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.match.scopes).toContain("subject");
    expect(hits[0]!.relevance.score).toBeGreaterThan(0);
    expect(hits[0]!.relevance.reasons.length).toBeGreaterThan(0);
  });

  it("без запроса релевантность нулевая и порядок задаёт Fit Score", () => {
    const hits = searchRows(rows, defaultFilters);
    expect(hits).toHaveLength(rows.length);
    for (const hit of hits) {
      expect(hit.match.matched).toBe(true);
      expect(hit.relevance.score).toBe(0);
      expect(hit.combined).toBe(
        combineRelevanceAndFit(0, hit.row.analysis.fitScore),
      );
    }
  });

  it("filterRows — это строки из searchRows", () => {
    const filters = withFilters({ search: "вентиль" });
    expect(filterRows(rows, filters).map((r) => r.tender.id)).toEqual(
      searchRows(rows, filters).map((h) => h.row.tender.id),
    );
  });
});

/* ============================== Цена без НМЦ и валюта ============================== */

describe("видимость цены в ленте", () => {
  it("закупка без цены не исчезает при заданном минимуме", () => {
    // Главный дефект прежнего поиска: цена хранится нулём, и «от 100 000 ₽»
    // молча вычёркивало все коммерческие торги без НМЦ.
    const noPrice = rowWithFinancial({ price: 0, currency: "RUB" });
    expect(filterRows([noPrice], withFilters({ minPrice: 100_000 }))).toHaveLength(1);
  });

  it("цена в границах по-прежнему отсекает лишнее", () => {
    const cheap = rowWithFinancial({ price: 10_000, currency: "RUB" });
    const fits = rowWithFinancial({ price: 500_000, currency: "RUB" }, rows[1]!);
    const filters = withFilters({ minPrice: 100_000, maxPrice: 1_000_000 });
    const filtered = filterRows([cheap, fits], filters);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.tender.financial.price).toBe(500_000);
  });

  it("переключатель «без НМЦ» скрывает закупки с непубликованной ценой", () => {
    const noPrice = rowWithFinancial({ price: 0, currency: "RUB" });
    const withPrice = rowWithFinancial({ price: 500_000, currency: "RUB" }, rows[1]!);
    expect(
      filterRows([noPrice, withPrice], withFilters({ includeNoPrice: false })),
    ).toHaveLength(1);
  });

  it("переключатель валюты скрывает закупки не в рублях", () => {
    const usd = rowWithFinancial({ price: 5_000, currency: "USD" });
    const rub = rowWithFinancial({ price: 500_000, currency: "RUB" }, rows[1]!);
    expect(
      filterRows([usd, rub], withFilters({ includeForeignCurrency: false })),
    ).toHaveLength(1);
  });

  it("пустой код валюты считается рублём", () => {
    // Иначе импорт и старые записи попали бы в «валютные» и исчезли.
    const row = rowWithFinancial({ price: 500_000, currency: "" });
    expect(
      filterRows([row], withFilters({ includeForeignCurrency: false })),
    ).toHaveLength(1);
  });

  it("по умолчанию показываются и закупки без цены, и валютные", () => {
    expect(defaultFilters.includeNoPrice).toBe(true);
    expect(defaultFilters.includeForeignCurrency).toBe(true);
    const noPrice = rowWithFinancial({ price: 0, currency: "USD" });
    expect(filterRows([noPrice], defaultFilters)).toHaveLength(1);
  });

  it("набор фильтров из старого localStorage без переключателей цены не падает", () => {
    const legacy = { ...defaultFilters } as Partial<TenderFilters>;
    delete legacy.includeNoPrice;
    delete legacy.includeForeignCurrency;
    const noPrice = rowWithFinancial({ price: 0, currency: "RUB" });
    expect(filterRows([noPrice], legacy as TenderFilters)).toHaveLength(1);
  });
});

/* ============================== sortSearched ============================== */

/*
  Живой поиск ищет по запросу и по близким словам, предложенным моделью:
  «строительство» — ещё «ремонт» и «реконструкция». Найденное по близкому слову
  в названии слова «строительство» не содержит; без пометки происхождения оно
  исчезло бы из ленты сразу после поиска, который его нашёл.
*/
describe("закупка, найденная живым поиском по близкому слову", () => {
  const found = rowWith({ subject: "Капитальный ремонт кровли школы", liveQuery: "строительство" });

  it("показывается по запросу, которым найдена, хотя слова в названии нет", () => {
    expect(searchRows([found], withFilters({ search: "строительство" }))).toHaveLength(1);
  });

  it("регистр и пробелы запроса не важны", () => {
    expect(searchRows([found], withFilters({ search: "  Строительство " }))).toHaveLength(1);
  });

  it("по другому запросу не показывается", () => {
    expect(searchRows([found], withFilters({ search: "уборка" }))).toHaveLength(0);
  });

  it("слово-исключение сильнее пометки", () => {
    expect(searchRows([found], withFilters({ search: "строительство -кровля" }))).toHaveLength(0);
  });

  it("закупка без пометки по-прежнему ищется только по словам", () => {
    const plain = rowWith({ subject: "Капитальный ремонт кровли школы" });

    expect(searchRows([plain], withFilters({ search: "строительство" }))).toHaveLength(0);
  });
});

describe("закупка, отобранная моделью при обходе региона", () => {
  const found = rowWith({
    subject: "Устройство тротуара от остановки до переезда",
    senseKeywords: ["строительство", "ремонт"],
  });

  it("показывается по слову профиля, под которое отобрана", () => {
    expect(searchRows([found], withFilters({ searchKeywords: ["Ремонт", "кровля"] }))).toHaveLength(1);
  });

  it("по чужим словам не показывается", () => {
    expect(searchRows([found], withFilters({ searchKeywords: ["юрист"] }))).toHaveLength(0);
  });

  it("живой поиск: запрос, заданный словом профиля, тоже находит свою закупку", () => {
    const live = rowWith({ subject: "Благоустройство территории", liveQuery: "строительство" });

    expect(searchRows([live], withFilters({ searchKeywords: ["строительство"] }))).toHaveLength(1);
  });
});

describe("sortSearched", () => {
  it("сортировка по релевантности идёт по убыванию оценки", () => {
    const titleOnly = rowWith({ subject: "Поставка вентилей" });
    const titleAndDocuments = rowWith(
      {
        subject: "Поставка вентилей и оборудования",
        documents: [
          makeDocument({
            title: "Проект договора",
            text: "В проекте договора упоминается вентиль запорный.",
          }),
        ],
      },
      rows[1]!,
    );
    const hits = searchRows(
      [titleOnly, titleAndDocuments],
      withFilters({ search: "вентиль" }),
    );
    expect(hits).toHaveLength(2);

    const sorted = sortSearched(hits, "relevance", "desc");
    expect(sorted[0]!.combined).toBeGreaterThanOrEqual(sorted[1]!.combined);
  });

  it("слово только в теле документации закупку не находит: предмет закупки назван в названии", () => {
    const documentsOnly = rowWith(
      {
        subject: "Поставка оборудования",
        documents: [makeDocument({ title: "Проект договора", text: "Упоминается вентиль запорный." })],
      },
      rows[1]!,
    );

    expect(searchRows([documentsOnly], withFilters({ search: "вентиль" }))).toHaveLength(0);
  });

  it("порядок прочих полей совпадает с sortRows", () => {
    const hits = searchRows(rows, defaultFilters);
    const bySearched = sortSearched(hits, "price", "asc").map(
      (h) => h.row.tender.id,
    );
    const byRows = sortRows(rows, "price", "asc").map((r) => r.tender.id);
    expect(bySearched).toEqual(byRows);
  });

  it("не мутирует исходный массив", () => {
    const hits = searchRows(rows, defaultFilters);
    const before = hits.map((h) => h.row.tender.id);
    sortSearched(hits, "relevance", "desc");
    expect(hits.map((h) => h.row.tender.id)).toEqual(before);
  });
});

describe("фильтр по партии прогона", () => {
  it("без метки партии выдача не сужена", () => {
    const input = [
      batchRow("BATCH", 50),
      freshRow("OLD", { firstSeenAt: "2026-09-01T09:00:00.000Z" }, 60),
    ];

    expect(filterRows(input, defaultFilters)).toHaveLength(2);
  });

  it("оставляет только строки, записанные прогоном с этой меткой", () => {
    const input = [
      batchRow("BATCH", 50),
      batchRow("OTHER_RUN", 55, { syncedAt: "2026-09-24T10:00:00.000Z" }),
      freshRow("OLD", { firstSeenAt: "2026-09-01T09:00:00.000Z" }, 60),
    ];

    const ids = filterRows(input, withFilters({ batchStamp: STAMP })).map(
      (r) => r.tender.id,
    );

    expect(ids).toEqual(["BATCH"]);
  });

  it("строка другого источника с той же меткой в партию не входит", () => {
    /*
      Метка записи сама по себе источник не доказывает: партия — это строки
      прогона Контур.Закупок, а не всё, что совпало с меткой по секунде.
    */
    const input = [
      batchRow("BATCH", 50),
      batchRow("EIS_SAME_STAMP", 55, { dataSource: "EIS" }),
    ];

    const ids = filterRows(input, withFilters({ batchStamp: STAMP })).map(
      (r) => r.tender.id,
    );

    expect(ids).toEqual(["BATCH"]);
  });
});

/**
 * Переключатель «Скрыть закрытые».
 *
 * ЕИС отдаёт и закупки, приём заявок по которым давно закончился: замер
 * 04.10.2026 — 43 из 116, самая старая закрылась 26 дней назад. Лента их не
 * прячет, а помечает причиной («срок подачи истёк», вердикт «Не подходит») —
 * так человек видит, что закупка есть и почему она не для него. Но 43 строки
 * из 116 мешают читать список, и тем, кому закрытые не нужны, нужен способ их
 * убрать, не теряя при этом ничего по умолчанию.
 */
describe("filterRows — скрыть закрытые", () => {
  const HOUR = 3_600_000;

  function rowDueIn(hours: number): TenderRow {
    const base = demoTenders[0]!;
    const tender: Tender = {
      ...base,
      id: `due-${String(hours)}`,
      regNumber: `due-${String(hours)}`,
      deadlines: {
        ...base.deadlines,
        submissionEnd: new Date(Date.now() + hours * HOUR).toISOString(),
      },
    };
    return {
      tender,
      analysis: analyzeTender(tender, demoCompanyProfile),
      pipelineStatus: pipelineRepository.getStatus(tender.id),
    };
  }

  const closed = rowDueIn(-48);
  const open = rowDueIn(72);
  const noDeadline: TenderRow = (() => {
    const row = rowDueIn(72);
    return { ...row, tender: { ...row.tender, id: "no-deadline", deadlines: { ...row.tender.deadlines, submissionEnd: "" } } };
  })();

  it("по умолчанию закрытые остаются: их помечает вердикт, а не фильтр", () => {
    const result = filterRows([closed, open], withFilters({}));

    expect(result).toHaveLength(2);
  });

  it("с включённым переключателем закрытые уходят", () => {
    const result = filterRows([closed, open], withFilters({ hideClosed: true }));

    expect(result.map((row) => row.tender.id)).toEqual([open.tender.id]);
  });

  it("закупка без срока не считается закрытой: срок неизвестен, а не прошёл", () => {
    const result = filterRows([noDeadline], withFilters({ hideClosed: true }));

    expect(result).toHaveLength(1);
  });

  it("закрывающаяся через час ещё открыта", () => {
    const result = filterRows([rowDueIn(1)], withFilters({ hideClosed: true }));

    expect(result).toHaveLength(1);
  });
});
