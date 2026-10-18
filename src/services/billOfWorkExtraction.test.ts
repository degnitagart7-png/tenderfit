import { describe, expect, it, vi } from "vitest";

import {
  buildBillPrompt,
  extractBillOfWork,
  parseBillResponse,
  remoteBillRows,
  MAX_BILL_ROWS_PER_CHUNK,
  type BillRowsFetcher,
  type BillRowsRequest,
} from "@/services/billOfWorkExtraction";
import { MIN_QUOTE_CHARS } from "@/domain/estimate/billExtraction";

const CONTEXT = {
  regNumber: "32616404800",
  subject: "Реконструкция запорных колодцев",
};

const SOURCE = [
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 Разработка грунта в отвал экскаваторами | м3 | 1 240,5",
  "2 Устройство основания под фундаменты песчаного | м3 | 120",
].join("\n");

function answer(
  rows: readonly Record<string, unknown>[],
  hasBill = true,
): string {
  return JSON.stringify({ has_bill: hasBill, rows });
}

/** Модель, отвечающая заранее заданным текстом. Сеть в тестах не трогаем. */
function fetcherFor(...replies: string[]): BillRowsFetcher {
  const queue = [...replies];
  return vi.fn(async (_request: BillRowsRequest) => {
    const raw = queue.shift() ?? answer([], false);
    const parsed = parseBillResponse(raw);
    return { ...parsed, tokens: 100 };
  });
}

describe("buildBillPrompt", () => {
  it("называет закупку, документ и предмет", () => {
    const prompt = buildBillPrompt("текст", CONTEXT, "Ведомость.docx");

    expect(prompt).toContain("32616404800");
    expect(prompt).toContain("Реконструкция запорных колодцев");
    expect(prompt).toContain("Ведомость.docx");
  });

  it("запрещает модели считать и достраивать ведомость", () => {
    const prompt = buildBillPrompt("текст", CONTEXT, "Ведомость.docx");

    expect(prompt).toContain("Ничего не считай");
    expect(prompt).toContain("Не достраивай ведомость");
    expect(prompt).toContain(String(MAX_BILL_ROWS_PER_CHUNK));
  });

  it("просит заголовок таблицы в разделе и запрещает таблицы машин, СИЗ и графики", () => {
    const prompt = buildBillPrompt("текст", CONTEXT, "Проект.pdf");

    expect(prompt).toContain("заголовок раздела или таблицы");
    expect(prompt).toContain("Таблицы потребности");
    expect(prompt).toContain("«100 m3», «мз», «1т груза»");
    expect(prompt).toContain("«103,65/82,92» при «м3/т»");
  });

  it("просит копировать единицу вместе с множителем и никогда его не отбрасывать", () => {
    const prompt = buildBillPrompt("текст", CONTEXT, "Ведомость.docx");

    expect(prompt).toContain("Множитель — часть единицы");
    expect(prompt).toContain("«100 м2», «1000 м3», «10 м3», «100 м», «100 шт», «1000 шт», «10 компл»");
    expect(prompt).toContain("unit = «100 м2» и quantity = 0,899");
    expect(prompt).toContain("никогда не отбрасывай «100»");
  });

  it("кладёт текст документа в конец, после всех правил", () => {
    const prompt = buildBillPrompt("ТЕКСТ-МАРКЕР", CONTEXT, "Ведомость.docx");

    expect(prompt.indexOf("ТЕКСТ-МАРКЕР")).toBeGreaterThan(
      prompt.indexOf("Ничего не считай"),
    );
  });
});

describe("parseBillResponse", () => {
  it("читает ответ в ограждении из обратных кавычек", () => {
    const raw = `\`\`\`json\n${answer([
      {
        work_name: "Кладка стен",
        quantity: "84,75",
        unit: "м3",
        evidence_quote: "Кладка стен | м3 | 84,75",
      },
    ])}\n\`\`\``;

    expect(parseBillResponse(raw).rows).toHaveLength(1);
  });

  it("переносит поля в доменные имена", () => {
    const { rows, hasBill } = parseBillResponse(
      answer([
        {
          work_name: "Кладка стен",
          quantity: 84.75,
          unit: "м3",
          evidence_quote: "Кладка стен | м3 | 84,75",
          section: "Раздел 2",
        },
      ]),
    );

    expect(hasBill).toBe(true);
    expect(rows[0]).toEqual({
      workName: "Кладка стен",
      quantity: 84.75,
      unit: "м3",
      evidenceQuote: "Кладка стен | м3 | 84,75",
      section: "Раздел 2",
    });
  });

  it("на не-JSON падает с длиной и началом ответа", () => {
    expect(() => parseBillResponse("извините, не смог")).toThrow(/не JSON/);
  });
});

describe("extractBillOfWork", () => {
  it("собирает раздел по документу из подтверждённых строк", async () => {
    const report = await extractBillOfWork(
      [{ name: "Ведомость.docx", text: SOURCE }],
      CONTEXT,
      fetcherFor(
        answer([
          {
            work_name: "Разработка грунта в отвал экскаваторами",
            quantity: "1 240,5",
            unit: "м3",
            evidence_quote:
              "Разработка грунта в отвал экскаваторами | м3 | 1 240,5",
          },
          {
            work_name: "Устройство основания под фундаменты песчаного",
            quantity: "120",
            unit: "м3",
            evidence_quote:
              "Устройство основания под фундаменты песчаного | м3 | 120",
          },
        ]),
      ),
    );

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]?.title).toBe("Ведомость.docx");
    expect(report.sections[0]?.items.map((item) => item.quantity)).toEqual([
      1240.5, 120,
    ]);
    expect(report.rejected).toEqual([]);
  });

  it("выдуманную строку в ведомость не пускает и называет причину", async () => {
    const report = await extractBillOfWork(
      [{ name: "Ведомость.docx", text: SOURCE }],
      CONTEXT,
      fetcherFor(
        answer([
          {
            work_name: "Монтаж металлоконструкций",
            quantity: "42",
            unit: "т",
            evidence_quote: "Монтаж металлоконструкций | т | 42",
          },
        ]),
      ),
    );

    expect(report.sections).toEqual([]);
    expect(report.rejected[0]?.reason).toBe("QUOTE_NOT_FOUND");
  });

  it("подменённый объём при настоящей цитате не проходит", async () => {
    const report = await extractBillOfWork(
      [{ name: "Ведомость.docx", text: SOURCE }],
      CONTEXT,
      fetcherFor(
        answer([
          {
            work_name: "Устройство основания под фундаменты песчаного",
            quantity: "1200",
            unit: "м3",
            evidence_quote:
              "Устройство основания под фундаменты песчаного | м3 | 120",
          },
        ]),
      ),
    );

    expect(report.rejected[0]?.reason).toBe("QUANTITY_NOT_IN_QUOTE");
  });

  it("документ без ведомости называет отдельно, а не молчит", async () => {
    const report = await extractBillOfWork(
      // Имя ничего не говорит о безобъёмном документе, поэтому модель читает его и сообщает «ведомости нет».
      // Проект контракта без объёмов модель не читает вовсе: см. documentRelevance.test.ts.
      [{ name: "Пояснительная записка.docx", text: "Раздел 5. Ответственность" }],
      CONTEXT,
      fetcherFor(answer([], false)),
    );

    expect(report.sections).toEqual([]);
    expect(report.documentsWithoutBill).toEqual(["Пояснительная записка.docx"]);
    expect(report.skippedNoVolumes).toEqual([]);
  });

  it("идентификаторы позиций разных документов не сталкиваются", async () => {
    const report = await extractBillOfWork(
      [
        { name: "Первый.docx", text: SOURCE },
        { name: "Второй.docx", text: SOURCE },
      ],
      CONTEXT,
      fetcherFor(
        answer([
          {
            work_name: "Разработка грунта в отвал экскаваторами",
            quantity: "1 240,5",
            unit: "м3",
            evidence_quote:
              "Разработка грунта в отвал экскаваторами | м3 | 1 240,5",
          },
        ]),
        answer([
          {
            work_name: "Устройство основания под фундаменты песчаного",
            quantity: "120",
            unit: "м3",
            evidence_quote:
              "Устройство основания под фундаменты песчаного | м3 | 120",
          },
        ]),
      ),
    );

    const ids = report.sections.flatMap((section) =>
      section.items.map((item) => item.id),
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["d1c1-1", "d2c1-1"]);
  });

  it("считает потраченные токены по всем вызовам", async () => {
    const report = await extractBillOfWork(
      [
        { name: "Первый.docx", text: SOURCE },
        { name: "Второй.docx", text: SOURCE },
      ],
      CONTEXT,
      fetcherFor(answer([], false), answer([], false)),
    );

    expect(report.tokensUsed).toBe(200);
  });

  it("на пустом наборе документов не зовёт модель вовсе", async () => {
    const fetcher = fetcherFor();
    const report = await extractBillOfWork([], CONTEXT, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(report.sections).toEqual([]);
  });
});

describe("remoteBillRows", () => {
  /**
   * Ключ языковой модели живёт только на проде: сервер воркера зовёт модель
   * через него. Проверяется, что наружу уходит фрагмент и его окружение, а не
   * готовый запрос к модели — иначе ручка стала бы бесплатным прокси к
   * платному шлюзу.
   */
  it("шлёт на прод фрагмент и окружение, а не готовый запрос к модели", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ rows: [], hasBill: false, tokens: 7, malformed: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const answer = await remoteBillRows("https://prod.example")({
      chunk: "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
      context: CONTEXT,
      documentName: "ВОР.docx",
    });

    expect(calls[0]?.url).toBe("https://prod.example/api/estimate/bill-rows");
    expect(calls[0]?.body).toEqual({
      chunk: "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
      regNumber: CONTEXT.regNumber,
      subject: CONTEXT.subject,
      documentName: "ВОР.docx",
    });
    expect(Object.keys(calls[0]?.body ?? {})).not.toContain("prompt");
    expect(answer.tokens).toBe(7);

    vi.unstubAllGlobals();
  });

  it("страницу 404 превращает в понятную ошибку, а не в сбой разбора JSON", async () => {
    /*
      Адрес без этого маршрута отдаёт HTML-страницу целиком. Если разбирать
      тело раньше проверки кода, воркер получит «Unexpected token <» и потеряет
      единственное, по чему это чинят, — код ответа.
    */
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!DOCTYPE html><html><body>ОШИБКА 404</body></html>", {
            status: 404,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );

    await expect(
      remoteBillRows("https://tender-fit.ru")({
        chunk: "текст",
        context: CONTEXT,
        documentName: "ВОР.docx",
      }),
    ).rejects.toThrow(/HTTP 404/);

    vi.unstubAllGlobals();
  });

  it("отказ прода превращает в понятную ошибку, а не в пустую ведомость", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Не задан ключ модели" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      remoteBillRows("https://prod.example")({
        chunk: "текст",
        context: CONTEXT,
        documentName: "ВОР.docx",
      }),
    ).rejects.toThrow(/Не задан ключ модели/);

    vi.unstubAllGlobals();
  });
});

/**
 * Обоснование строки отличает поставку от работы, поэтому модель обязана его
 * возвращать. Без него пять строк сметы 02-01-02-КМ1 ушли в подбор расценки и
 * принесли оттуда труд и машины, которых в смете заказчика нет.
 */
describe("обоснование строки", () => {
  it("модель просят вернуть обоснование", () => {
    const prompt = buildBillPrompt("текст", CONTEXT, "Ведомость.docx");

    expect(prompt).toContain("justification");
  });

  it("обоснование доходит до позиции ведомости", () => {
    const parsed = parseBillResponse(
      answer([
        {
          work_name: "Металлоконструкции вспомогательного назначения, сталь С255",
          quantity: "12,5",
          unit: "т",
          evidence_quote: "Металлоконструкции вспомогательного назначения, сталь С255",
          quantity_quote: "12,5",
          justification: "ФСБЦ-07.2.07.12-0068",
        },
      ]),
    );

    expect(parsed.rows[0]?.justification).toBe("ФСБЦ-07.2.07.12-0068");
  });

  it("строка без обоснования разбирается по-прежнему", () => {
    const parsed = parseBillResponse(
      answer([
        {
          work_name: "Разработка грунта в отвал экскаваторами",
          quantity: "1 240,5",
          unit: "м3",
          evidence_quote: "Разработка грунта в отвал экскаваторами",
          quantity_quote: "1 240,5",
          justification: null,
        },
      ]),
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.justification).toBeUndefined();
  });
});

/**
 * Промпт обязан назвать минимальную длину фрагмента.
 *
 * Без этого модель отдаёт обрывки вроде «т;12,5»: формально верные, но
 * неотличимые от соседней строки таблицы, — и строка выбывает из ведомости.
 * На живом прогоне так потерялись две позиции из трёх.
 */
describe("длина фрагментов в промпте", () => {
  it("модель предупреждена о минимальной длине", () => {
    const prompt = buildBillPrompt("текст", CONTEXT, "Ведомость.docx");

    expect(prompt).toContain(`не короче ${String(MIN_QUOTE_CHARS)} знаков`);
  });
});

/**
 * Раздел позиции определяется по месту цитаты в документе, а не со слов модели.
 *
 * Главный случай: документ режется на фрагменты по 100 000 знаков, и заголовок
 * «Раздел 2. …» остаётся в предыдущем фрагменте, а модель, видя только следующий,
 * раздела не называет вовсе.
 */
describe("extractBillOfWork: billSection", () => {
  const FILLER = "Описание условий выполнения работ и порядка приёмки. ";

  const row = (name: string, quantity: string, extra: Record<string, unknown> = {}) => ({
    work_name: name,
    quantity,
    unit: "м3",
    evidence_quote: `${name} | м3 | ${quantity}`,
    ...extra,
  });

  it("заголовок остался в предыдущем фрагменте — раздел всё равно найден", async () => {
    const text = [
      "Раздел 1. Демонтажные работы",
      "Демонтаж перегородок кирпичных | м3 | 15,5",
      "Раздел 2. Ремонтные работы",
      FILLER.repeat(2200),
      "Устройство стяжки цементной | м3 | 42",
      "Раздел 3. Благоустройство",
      "Устройство газонов с посевом | м3 | 7",
    ].join("\n");
    const requests: BillRowsRequest[] = [];
    const replies = [
      answer([row("Демонтаж перегородок кирпичных", "15,5")]),
      // Модель второго фрагмента заголовка раздела 2 не видит и раздела не называет.
      answer([
        row("Устройство стяжки цементной", "42"),
        row("Устройство газонов с посевом", "7", { section: "Благоустройство (по модели)" }),
      ]),
    ];
    const fetcher: BillRowsFetcher = async (request) => {
      requests.push(request);
      return { ...parseBillResponse(replies.shift() ?? answer([], false)), tokens: 1 };
    };

    const report = await extractBillOfWork([{ name: "Ведомость.docx", text }], CONTEXT, fetcher);

    expect(requests).toHaveLength(2);
    expect(text.indexOf("Раздел 2. Ремонтные работы")).toBeLessThan(requests[0]!.chunk.length);
    const items = report.sections[0]!.items;
    expect(items.map((item) => item.billSection)).toEqual([
      "Демонтажные работы",
      "Ремонтные работы",
      // Заголовок по тексту сильнее поля модели.
      "Благоустройство",
    ]);
  });

  it("заголовков нет — запасной вариант: поле «раздел» модели", async () => {
    const report = await extractBillOfWork(
      [{ name: "Ведомость.docx", text: SOURCE }],
      CONTEXT,
      fetcherFor(
        answer([
          row("Разработка грунта в отвал экскаваторами", "1 240,5", { section: "  Земляные   работы " }),
          row("Устройство основания под фундаменты песчаного", "120"),
        ]),
      ),
    );

    expect(report.sections[0]!.items.map((item) => item.billSection)).toEqual(["Земляные работы", null]);
  });

  it("позиция после итога сметы вне раздела — берётся поле модели, а не прошлый раздел", async () => {
    const text = [
      "Раздел 1. Монтаж",
      "ВСЕГО по смете;;;;;100,00",
      "Устройство основания под фундаменты песчаного | м3 | 120",
    ].join("\n");
    const report = await extractBillOfWork(
      [{ name: "Ведомость.docx", text }],
      CONTEXT,
      fetcherFor(answer([row("Устройство основания под фундаменты песчаного", "120")])),
    );

    expect(report.sections[0]!.items[0]!.billSection).toBeNull();
  });

  it("цитата со схлопнутыми пробелами и ё ищется на своём месте, а не на первом вхождении", async () => {
    const text = [
      "Раздел 1. Первый",
      "Монтаж   щита |  шт | 2",
      "Раздел 2. Второй",
      "Монтаж щита | шт | 5",
    ].join("\n");
    const report = await extractBillOfWork(
      [{ name: "Ведомость.docx", text }],
      CONTEXT,
      fetcherFor(
        answer([
          {
            work_name: "Монтаж щита",
            quantity: "5",
            unit: "шт",
            evidence_quote: "Монтаж щита",
            quantity_quote: "Монтаж щита | шт | 5",
          },
        ]),
      ),
    );

    // Наименование встречается дважды; берётся то, что рядом с цитатой объёма.
    expect(report.sections[0]!.items[0]!.billSection).toBe("Второй");
  });
});
