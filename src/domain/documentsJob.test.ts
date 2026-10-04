import { describe, expect, it } from "vitest";
import {
  PAID_CARD_JOB_LIMIT,
  documentsJobOptions,
} from "./documentsJob";
import type { SyncJobPayload } from "@/types/database";

/*
  Задание на документацию — единственное место, где может быть потрачен платный
  запрос карточки Контур.Закупок (группа `purchase`, 30 в сутки). Правила здесь
  чистые и проверяются без сети и базы, потому что цена ошибки — суточный бюджет
  источника, который сгорает за один тик воркера и не возвращается.
*/

function payload(overrides: Partial<SyncJobPayload> = {}): SyncJobPayload {
  return { regNumbers: ["RH24092600035"], reason: "kontur-card", ...overrides };
}

describe("documentsJobOptions", () => {
  it("бесплатное задание не покупает карточку и не запускает разбор", () => {
    expect(
      documentsJobOptions(payload({ konturCards: false })),
    ).toEqual({ konturCards: false, runWorker: false, cardRefusal: null });
  });

  it("задание без флага бесплатно: строки, созданные до флага, читаются как бесплатные", () => {
    expect(documentsJobOptions({ regNumbers: ["32616407955"], reason: "press" })).toEqual({
      konturCards: false,
      runWorker: false,
      cardRefusal: null,
    });
  });

  it("пустой payload не роняет воркер и ничего не покупает", () => {
    expect(documentsJobOptions(null)).toEqual({
      konturCards: false,
      runWorker: false,
      cardRefusal: null,
    });
    expect(documentsJobOptions(undefined)).toMatchObject({ konturCards: false });
  });

  /*
    Смысл платного задания: партнёр нажал кнопку на одной закупке и согласился
    заплатить. Без запуска разбора он получил бы имена файлов и ждал бы модель
    до следующего планового прогона — то есть заплатил и снова ждёт два часа.
  */
  it("платное задание покупает карточку и сразу доводит закупку до разбора", () => {
    expect(documentsJobOptions(payload({ konturCards: true }))).toEqual({
      konturCards: true,
      runWorker: true,
      cardRefusal: null,
    });
  });

  it("массовое задание с флагом остаётся бесплатным и объясняет отказ", () => {
    const numbers = Array.from(
      { length: PAID_CARD_JOB_LIMIT + 1 },
      (_, index) => `n${index}`,
    );

    const options = documentsJobOptions(payload({ regNumbers: numbers, konturCards: true }));

    expect(options).toEqual({ konturCards: false, runWorker: false, cardRefusal: options.cardRefusal });
    expect(options.cardRefusal).toMatch(/6 закупок/);
    expect(options.cardRefusal).toMatch(/при пределе 5/);
    expect(options.cardRefusal).toMatch(/бесплатно/);
  });

  it("предел допускает ровно столько закупок, сколько названо", () => {
    const numbers = Array.from({ length: PAID_CARD_JOB_LIMIT }, (_, index) => `n${index}`);

    expect(documentsJobOptions(payload({ regNumbers: numbers, konturCards: true }))).toEqual({
      konturCards: true,
      runWorker: true,
      cardRefusal: null,
    });
  });
});
