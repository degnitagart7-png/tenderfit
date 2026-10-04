import { beforeEach, describe, expect, it, vi } from "vitest";
import { tenderApiService } from "@/services/tenderApiService";
import type { CompanyProfile, ImportedTender } from "@/domain/entities";
import type { TenderRow } from "@/types/database";

/** Профиль компании: нужен скорингу, значения на суть тестов не влияют. */
const profile: CompanyProfile = {
  organizationId: "org-1",
  legalName: "ООО Тест",
  inn: "7701234567",
  legalForm: "OOO",
  taxSystem: "OSNO",
  worksWithVat: true,
  activityDescription: "Поставка техники",
  capabilities: {
    products: ["компьютеры"],
    works: [],
    services: [],
    brandsAndModels: [],
    keywords: [],
    synonyms: [],
    stopWords: [],
    okpd2Codes: ["26.20"],
  },
  restrictions: {
    minPrice: 50_000,
    maxPrice: 5_000_000,
    maxDistanceKm: null,
    maxPaymentTermDays: 30,
    minDeliveryTermDays: 14,
    minMarginPercent: 10,
    maxBidSecurity: 100_000,
    maxContractSecurity: 500_000,
    allowNoAdvance: true,
    workRegions: ["Москва"],
    customerWhitelist: [],
    customerBlacklist: [],
    custom: [],
  },
  preferences: {
    priorityRegions: [],
    preferredMinPrice: null,
    preferredMaxPrice: null,
    preferAdvance: false,
    preferShortPaymentTerm: false,
    priorityBrands: [],
    avoidTreasurySupport: false,
    notes: [],
  },
  licenses: [],
  sroMemberships: [],
  hasPersonnel: true,
  hasEquipment: true,
  hasSpecialAccount: true,
  staff: { total: null, nrsCount: 0, noprizCount: 0 },
  experience: [],
  experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
  documents: [],
};

/** Строка БД ровно в том виде, в каком её отдаёт GET /api/tenders. */
function dbRow(overrides: Partial<TenderRow> = {}): TenderRow {
  return {
    id: "73b151d9-8c5a-4c8c-ad8f-f83cb11942bc",
    reg_number: "SBR028-2609080053",
    external_id: "4220506",
    law: "COMMERCIAL",
    placing_way: "REQUEST_FOR_PROPOSALS",
    subject: "Закупка комплексных услуг по оформлению и ведению ЭПЛ",
    customer_name: "ООО «НТС»",
    customer_inn: "7704314221",
    region: "Москва",
    delivery_address: null,
    price: null,
    currency: "RUB",
    advance_payment: null,
    security_bid: null,
    security_contract: null,
    submission_end: "2026-09-22T15:00:00+00:00",
    publication_date: "2026-09-08T11:56:00+00:00",
    last_update_date: "2026-09-10T13:20:00+00:00",
    delivery_term_days: null,
    delivery_date_end: null,
    okpd2_codes: null,
    lots: [],
    requirements: null,
    national_regime: false,
    only_for_smp: false,
    eis_url: "https://utp.sberbank-ast.ru/VIP/NBT/PurchaseView/632/0/0/4220506",
    data_source: "SBER_AST",
    change_log: null,
    created_at: "2026-09-21T19:51:07.180703+00:00",
    updated_at: "2026-09-21T19:51:07.180703+00:00",
    ...overrides,
  };
}

/** Заглушка fetch: отвечает телом списка закупок. */
function stubFetch(tenders: TenderRow[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tenders, count: tenders.length }),
    } as unknown as Response),
  );
}

/** URL первого вызова fetch — по нему проверяем, что запросили нужную закупку. */
function firstFetchUrl(): string {
  return String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0] ?? "");
}

describe("tenderApiService.getRowById", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("находит закупку из БД по реестровому номеру", async () => {
    stubFetch([dbRow()]);
    const row = await tenderApiService.getRowById("SBR028-2609080053", profile);
    expect(row?.tender.regNumber).toBe("SBR028-2609080053");
    expect(row?.tender.dataSource).toBe("SBER_AST");
    expect(row?.tender.law).toBe("COMMERCIAL");
    expect(row?.analysis).toBeTruthy();
  });

  it("запрашивает у API конкретный номер, а не первую попавшуюся запись", async () => {
    stubFetch([dbRow()]);
    await tenderApiService.getRowById("SBR028-2609080053", profile);
    expect(firstFetchUrl()).toContain("reg_number=SBR028-2609080053");
  });

  it("не выдаёт чужую закупку, если API вернул не ту строку", async () => {
    stubFetch([dbRow({ reg_number: "SBR028-2609080054" })]);
    await expect(
      tenderApiService.getRowById("SBR028-2609080053", profile),
    ).resolves.toBeNull();
  });

  it("пустая выдача — это null, а не ошибка", async () => {
    stubFetch([]);
    await expect(
      tenderApiService.getRowById("НЕТ-ТАКОГО-НОМЕРА", profile),
    ).resolves.toBeNull();
  });

  it("импортированную закупку отдаёт из localStorage, не дёргая API", async () => {
    const imported: ImportedTender = {
      id: "imp-1",
      regNumber: "ИМП-001",
      law: "FZ_44",
      placingWay: "ELECTRONIC_AUCTION",
      subject: "Поставка ноутбуков",
      customerName: "ГБУ Тест",
      customerInn: null,
      region: "Москва",
      price: 1_000_000,
      okpd2Codes: ["26.20"],
      submissionEnd: "2026-10-01T10:00:00.000Z",
      deliveryTermDays: null,
      documentsText: "",
      importedAt: "2026-09-21T10:00:00.000Z",
      source: "MANUAL",
    };
    localStorage.setItem("tf.importedTenders", JSON.stringify([imported]));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const row = await tenderApiService.getRowById("imp-1", profile);

    expect(row?.tender.id).toBe("imp-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/*
  Метки времени источника нужны экрану «Сегодня» и порядку в «Закупках»:
  по `synced_at` находится партия последнего прогона Контур, по `created_at` —
  появилась ли закупка в этом прогоне или лежала в базе раньше. Обе колонки
  приезжают из /api/tenders (репозиторий читает `select("*")`), поэтому здесь
  проверяем только маппинг: ничего не потеряно и ничего не выдумано.
*/
describe("tenderApiService.getRows: метки времени источника", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("несёт метку партии и дату первого появления из строки БД", async () => {
    stubFetch([
      dbRow({
        reg_number: "0387200008526000834",
        data_source: "KONTUR",
        synced_at: "2026-09-25T14:52:03.123456+00:00",
        created_at: "2026-09-25T14:52:04.001+00:00",
      }),
    ]);

    const rows = await tenderApiService.getRows(profile);

    expect(rows[0]?.tender.syncedAt).toBe("2026-09-25T14:52:03.123456+00:00");
    expect(rows[0]?.tender.firstSeenAt).toBe("2026-09-25T14:52:04.001+00:00");
  });

  it("нет метки синхронизации — null, а не придуманная дата", async () => {
    stubFetch([dbRow()]);

    const rows = await tenderApiService.getRows(profile);

    expect(rows[0]?.tender.syncedAt).toBeNull();
    expect(rows[0]?.tender.firstSeenAt).toBe("2026-09-21T19:51:07.180703+00:00");
  });

  it("импортированная закупка несёт дату импорта как первое появление", async () => {
    stubFetch([]);
    const imported: ImportedTender = {
      id: "imp-2",
      regNumber: "ИМП-002",
      law: "FZ_44",
      placingWay: "ELECTRONIC_AUCTION",
      subject: "Поставка ноутбуков",
      customerName: "ГБУ Тест",
      customerInn: null,
      region: "Москва",
      price: 1_000_000,
      okpd2Codes: ["26.20"],
      submissionEnd: "2026-10-01T10:00:00.000Z",
      deliveryTermDays: null,
      documentsText: "",
      importedAt: "2026-09-21T10:00:00.000Z",
      source: "MANUAL",
    };
    localStorage.setItem("tf.importedTenders", JSON.stringify([imported]));

    const rows = await tenderApiService.getRows(profile);

    expect(rows[0]?.tender.firstSeenAt).toBe("2026-09-21T10:00:00.000Z");
    expect(rows[0]?.tender.syncedAt).toBeNull();
  });
});

/**
 * Карточка обязана показывать скачанную документацию.
 *
 * Замер на живой карточке 32616426639 (01.10.2026): воркер сохранил два файла
 * на 199 003 знака, в журнале стоит «✓ 32616426639: сохранено 2», а карточка
 * показывала «Документы: 0 файлов». Разбор при этом шёл по названию и
 * реквизитам: «Выраженных положительных факторов не найдено», «Существенных
 * ограничений не найдено» — и это ровно то, что видно, когда читать нечего.
 *
 * Причина была в одной строке: преобразователь строки БД в закупку
 * подставлял `documents: []` вместо настоящего списка.
 */
describe("tenderApiService.getRowById — документация закупки", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubWithDocuments(documents: unknown[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        String(url).includes("/api/documents")
          ? ({ ok: true, json: async () => ({ documents }) } as unknown as Response)
          : ({
              ok: true,
              json: async () => ({ tenders: [dbRow()], count: 1 }),
            } as unknown as Response),
      ),
    );
  }

  it("документы доезжают до закупки", async () => {
    stubWithDocuments([
      {
        id: "d-1",
        filename: "Извещение.pdf",
        document_type: "NOTICE",
        file_url: "https://zakupki.gov.ru/f/1",
        parsed_text: "Требуется членство в СРО",
      },
    ]);

    const row = await tenderApiService.getRowById("SBR028-2609080053", profile);

    expect(row?.tender.documents).toHaveLength(1);
    expect(row?.tender.documents[0]?.fileName).toBe("Извещение.pdf");
    expect(row?.tender.documents[0]?.text).toContain("СРО");
  });

  it("закупка без документов остаётся читаемой", async () => {
    stubWithDocuments([]);

    const row = await tenderApiService.getRowById("SBR028-2609080053", profile);

    expect(row?.tender.documents).toEqual([]);
  });

  it("отказ в документах не роняет карточку", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        String(url).includes("/api/documents")
          ? ({ ok: false, status: 503, text: async () => "нет" } as unknown as Response)
          : ({
              ok: true,
              json: async () => ({ tenders: [dbRow()], count: 1 }),
            } as unknown as Response),
      ),
    );

    const row = await tenderApiService.getRowById("SBR028-2609080053", profile);

    expect(row?.tender.regNumber).toBe("SBR028-2609080053");
    expect(row?.tender.documents).toEqual([]);
  });
});
