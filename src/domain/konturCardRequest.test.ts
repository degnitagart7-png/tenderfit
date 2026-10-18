import { describe, expect, it } from "vitest";
import {
  konturCardBudgetNote,
  konturCardOffer,
  type KonturCardOfferInput,
} from "@/domain/konturCardRequest";

/*
  Живой случай, из-за которого появилось правило: закупка RH24092600035
  (Контур.Закупки, закон COMMERCIAL, АО «ДГК»). Прогон 25.09.2026 в 17:12 МСК
  дошёл до неё и напечатал, что ЕИС не публикует вкладку документов для
  COMMERCIAL: файлы перечисляет только карточка источника, а это платный запрос.
  Задача разбора при этом осталась «pending» навсегда, а карточка обещала
  догрузку плановой синхронизацией.
*/
function commercial(overrides: Partial<KonturCardOfferInput> = {}): KonturCardOfferInput {
  return {
    configured: true,
    dataSource: "KONTUR",
    law: "COMMERCIAL",
    externalId: "IS76922341",
    documentsCount: 0,
    cardRemaining: 28,
    analysisRemaining: 12,
    ...overrides,
  };
}

describe("предложение платной карточки Контур.Закупок", () => {
  it("коммерческая закупка без документов: карточка — единственный путь", () => {
    expect(konturCardOffer(commercial())).toEqual({
      show: true,
      allowed: true,
      reason: null,
      refusalKind: null,
    });
  });

  it("закупке 44-ФЗ блок не показывается: её документацию ЕИС отдаёт бесплатно", () => {
    // Предлагать платный запрос там, где через два часа те же файлы придут
    // даром, — это расход чужих денег без нужды.
    const offer = konturCardOffer(commercial({ law: "FZ_44" }));

    expect(offer.show).toBe(false);
    expect(offer.allowed).toBe(false);
  });

  it("документы уже в базе — платить не за что", () => {
    const offer = konturCardOffer(commercial({ documentsCount: 7 }));

    expect(offer).toEqual({ show: false, allowed: false, reason: null, refusalKind: null });
  });

  it("не Контур.Закупки — карточки источника нет вовсе", () => {
    const offer = konturCardOffer(commercial({ dataSource: "EIS" }));

    expect(offer).toEqual({ show: false, allowed: false, reason: null, refusalKind: null });
  });

  it("ключ не задан: блок виден и говорит, что покупать нечем", () => {
    const offer = konturCardOffer(commercial({ configured: false }));

    expect(offer.show).toBe(true);
    expect(offer.allowed).toBe(false);
    expect(offer.reason).toMatch(/ключ/i);
    expect(offer.refusalKind).toBe("config");
  });

  it("нет идентификатора в источнике: карточку не открыть", () => {
    const offer = konturCardOffer(commercial({ externalId: null }));

    expect(offer.show).toBe(true);
    expect(offer.allowed).toBe(false);
    expect(offer.reason).toMatch(/идентификатор/i);
    expect(offer.refusalKind).toBe("tender");
  });

  it("суточный бюджет карточек исчерпан: отказ с датой следующей попытки", () => {
    const offer = konturCardOffer(commercial({ cardRemaining: 0 }));

    expect(offer.show).toBe(true);
    expect(offer.allowed).toBe(false);
    expect(offer.reason).toMatch(/00:00 по Москве/);
    expect(offer.refusalKind).toBe("budget");
  });

  it("бюджет без ограничения (null) покупке не мешает", () => {
    const offer = konturCardOffer(commercial({ cardRemaining: null }));

    expect(offer.allowed).toBe(true);
  });

  /*
    Карточка нужна не сама по себе, а чтобы модель прочитала документацию.
    Купить её при исчерпанном лимите разборов — значит потратить платный запрос
    и оставить файлы неразобранными до завтра.
  */
  it("лимит разборов на сегодня исчерпан: карточку не покупаем", () => {
    const offer = konturCardOffer(commercial({ analysisRemaining: 0 }));

    expect(offer.show).toBe(true);
    expect(offer.allowed).toBe(false);
    expect(offer.reason).toMatch(/лимит разборов/i);
    expect(offer.refusalKind).toBe("analysis");
  });

  it("закупка уже стоит в очереди разбора: новый расход лимита не мешает покупке", () => {
    const offer = konturCardOffer(commercial({ analysisRemaining: null }));

    expect(offer.allowed).toBe(true);
    expect(offer.refusalKind).toBeNull();
  });
});

describe("подпись расхода карточек", () => {
  it("называет истраченное и остаток из предела", () => {
    expect(konturCardBudgetNote(2, 30)).toBe("Карточек Контур.Закупок сегодня: 2 из 30, осталось 28");
  });

  it("остаток считает от предела, а не выдумывает", () => {
    expect(konturCardBudgetNote(1, 30)).toContain("1 из 30");
    expect(konturCardBudgetNote(21, 30)).toContain("осталось 9");
    expect(konturCardBudgetNote(45, 30)).toContain("осталось 0");
  });

  it("предела нет — остаток не выдумывает", () => {
    expect(konturCardBudgetNote(3, null)).toBe(
      "Карточек Контур.Закупок сегодня: 3, суточного предела нет",
    );
  });
});
