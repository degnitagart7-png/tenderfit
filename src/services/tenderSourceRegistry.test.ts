import { describe, expect, it } from "vitest";
import {
  SOURCE_BINDINGS,
  createTektorgAdapter,
  sourceBinding,
} from "./tenderSourceRegistry";
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
    //   ЕИС       — регионального фильтра в GET-выдаче нет (docs/ACCESS_EIS.md),
    //               и в самой выдаче региона тоже нет, поэтому отобрать по нему
    //               нельзя ни на запросе, ни после него;
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
    //   Контур    — принимает только UUID регионов, поэтому отсеивает выдачу сам.
    expect(sourceBinding("EIS")?.honoursRegions).toBe(false);
    expect(sourceBinding("TEK_TORG")?.honoursRegions).toBe(true);
    expect(sourceBinding("SBER_AST")?.honoursRegions).toBe(true);
    expect(sourceBinding("ROSELTORG")?.honoursRegions).toBe(true);
    expect(sourceBinding("FABRIKANT")?.honoursRegions).toBe(true);
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
    ] as const) {
      const adapter = await sourceBinding(source)?.create();
      expect(adapter, source).not.toBeNull();
    }
  });

  it("фабрика ТЭК-Торга отдаёт адаптер с чтением списка документов", () => {
    // Реестр возвращает `TenderSourceAdapter` — интерфейс, в котором нет
    // `readDocumentList`. Загрузчику документации нужен именно он, и без этой
    // проверки метод мог бы пропасть из фабрики, оставшись в привязке.
    const adapter = createTektorgAdapter();
    expect(typeof adapter.readDocumentList).toBe("function");
  });
});
