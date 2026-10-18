import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_BINDINGS,
  resolveEisRatePerSec,
  createEtpgpbAdapter,
  createTektorgAdapter,
  isEtpgpbDisabled,
  sourceBinding,
} from "./tenderSourceRegistry";
import { EtpgpbTenderSourceAdapter } from "@/adapters/tender-source/etpgpbTenderSourceAdapter";
import { isEtpgpbUrlAllowed } from "@/adapters/tender-source/etpgpbUrl";
import { SOURCES } from "@/domain/sources";
import type { TenderDataSource } from "@/types/database";

describe("реестр привязок источника", () => {
  it("покрывает ровно те источники, которые плановый прогон умеет собирать", () => {
    const syncable = SOURCES.filter(
      (s) => s.source !== "MOCK" && s.source !== "IMPORT",
    ).map((s) => s.source);
    const bound = SOURCE_BINDINGS.map((b) => b.source);
    expect([...bound].sort()).toEqual([...syncable].sort());
  });

  it("у каждой привязки источник описан в каталоге", () => {
    const listed: TenderDataSource[] = SOURCES.map((s) => s.source);
    for (const b of SOURCE_BINDINGS) {
      expect(listed, b.source).toContain(b.source);
    }
  });

  it("интервал платного источника задан, бесплатного — нет", () => {
    for (const b of SOURCE_BINDINGS) {
      const facts = SOURCES.find((s) => s.source === b.source);
      if (facts?.cost === "paid") {
        expect(b.cadenceHours, b.source).toBeTypeOf("number");
      } else {
        expect(b.cadenceHours, b.source).toBeNull();
      }
    }
  });

  it("точка проверки связи есть у каждой привязки и не расходует платный запрос", () => {
    for (const b of SOURCE_BINDINGS) {
      expect(b.probeUrl, b.source).toMatch(/^https:\/\//);
    }
    // Публичные страницы, а не API: проверка связи не должна тратить тариф.
    expect(sourceBinding("KONTUR")?.probeUrl).toBe("https://zakupki.kontur.ru/");
  });

  it("привязку несуществующего источника не выдумываем", () => {
    expect(sourceBinding("MOCK")).toBeNull();
  });

  it("про каждую привязку известно, применяет ли она фильтр по региону", () => {
    for (const b of SOURCE_BINDINGS) {
      expect(typeof b.honoursRegions, b.source).toBe("boolean");
    }
    // Факты из осмотра источников, а не догадка:
    //   ЕИС       — фильтр по региону заказчика есть в запросе (customerPlace +
    //               customerPlaceCodes, код по КЛАДР), проверено 05.10.2026;
    //   ТЭК-Торг  — в запросе SOAP нет ни одного параметра региона, зато регион
    //               приходит в ответе адресом организатора и местом поставки лота,
    //               поэтому адаптер применяет фильтр профиля на своей стороне;
    //   Сбербанк-АСТ — фильтрует на своей стороне по подстроке названия;
    //   Росэлторг — параметра региона в форме поиска нет, зато регион заказчика
    //               напечатан в строке выдачи, поэтому отсеивает адаптер сам;
    //   Фабрикант — региона в форме поиска нет (параметр `customer_region_ids[]`
    //               фильтрует по региону заказчика, а не по месту поставки), зато
    //               карточка печатает регион и адрес поставки лота, поэтому
    //               отсеивает адаптер сам;
    //   ЭТП ГПБ   — в карте сайта региона нет, а поиск запрещён robots.txt; регион
    //               определяется по карточке, поэтому отсеивает адаптер сам;
    //   Контур    — принимает только UUID регионов, поэтому отсеивает выдачу сам.
    expect(sourceBinding("EIS")?.honoursRegions).toBe(true);
    expect(sourceBinding("TEK_TORG")?.honoursRegions).toBe(true);
    expect(sourceBinding("SBER_AST")?.honoursRegions).toBe(true);
    expect(sourceBinding("ROSELTORG")?.honoursRegions).toBe(true);
    expect(sourceBinding("FABRIKANT")?.honoursRegions).toBe(true);
    expect(sourceBinding("ETP_GPB")?.honoursRegions).toBe(true);
    expect(sourceBinding("KONTUR")?.honoursRegions).toBe(true);
  });

  it("бесплатный источник без ключа создаёт адаптер, а не молча возвращает null", async () => {
    // Контур.Закупки здесь нет намеренно: их привязка читает ключ и журнал расхода
    // в базе, а тест в сеть и в базу не ходит.
    for (const source of [
      "EIS",
      "TEK_TORG",
      "SBER_AST",
      "ROSELTORG",
      "FABRIKANT",
      "ETP_GPB",
    ] as const) {
      const adapter = await sourceBinding(source)?.create();
      expect(adapter, source).not.toBeNull();
    }
  });

  it("проверка связи ЭТП ГПБ ходит только по адресу, разрешённому robots.txt", () => {
    // Главная страница в разрешённый набор не входит: проверка связи — тоже запрос.
    const probe = sourceBinding("ETP_GPB")?.probeUrl ?? "";
    expect(probe).toBe("https://etpgpb.ru/sitemap.xml");
    expect(isEtpgpbUrlAllowed(probe)).toBe(true);
  });

  it("фабрика ТЭК-Торга отдаёт адаптер с чтением списка документов", () => {
    // Реестр возвращает `TenderSourceAdapter` — интерфейс, в котором нет
    // `readDocumentList`. Загрузчику документации нужен именно он, и без этой
    // проверки метод мог бы пропасть из фабрики, оставшись в привязке.
    const adapter = createTektorgAdapter();
    expect(typeof adapter.readDocumentList).toBe("function");
  });
});

describe("скорость запросов к ЕИС (EIS_RATE_PER_SEC)", () => {
  it("без переменной остаётся прежнее значение", () => {
    expect(resolveEisRatePerSec(undefined)).toBe(2);
    expect(resolveEisRatePerSec("")).toBe(2);
  });

  it("принимает дробное значение, как у обхода при параллельном воркере", () => {
    expect(resolveEisRatePerSec("1.5")).toBe(1.5);
    expect(resolveEisRatePerSec(" 1 ")).toBe(1);
  });

  it("мусор, ноль и минус возвращают умолчание, а не останавливают прогон и не снимают лимит", () => {
    for (const raw of ["abc", "0", "-1", "NaN", "Infinity"]) {
      expect(resolveEisRatePerSec(raw), raw).toBe(2);
    }
  });

  it("слишком большое значение упирается в потолок", () => {
    expect(resolveEisRatePerSec("100")).toBe(5);
  });
});

describe("ЭТП ГПБ: фабрика и выключатель", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("фабрика отдаёт адаптер конкретным классом, с потолками по умолчанию и без смены темпа", () => {
    const adapter = createEtpgpbAdapter();
    expect(adapter).toBeInstanceOf(EtpgpbTenderSourceAdapter);
    expect(typeof adapter.configureBudgets).toBe("function");
  });

  it("SYNC_ETPGPB_DISABLED выключает источник: привязка возвращает null, а не падает", async () => {
    for (const raw of ["1", "true", "TRUE", " yes "]) {
      expect(isEtpgpbDisabled(raw), raw).toBe(true);
    }
    for (const raw of [undefined, "", "0", "false", "no", "нет"]) {
      expect(isEtpgpbDisabled(raw), String(raw)).toBe(false);
    }
    vi.stubEnv("SYNC_ETPGPB_DISABLED", "1");
    expect(await sourceBinding("ETP_GPB")?.create()).toBeNull();
    vi.stubEnv("SYNC_ETPGPB_DISABLED", "0");
    expect(await sourceBinding("ETP_GPB")?.create()).not.toBeNull();
  });
});
