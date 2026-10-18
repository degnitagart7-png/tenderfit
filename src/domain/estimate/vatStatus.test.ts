import { describe, expect, it } from "vitest";

import type { TenderLaw } from "@/domain/enums";
import { detectVatStatus } from "@/domain/estimate/vatStatus";

function detect(texts: readonly string[], law: TenderLaw | null | undefined = "FZ_223") {
  return detectVatStatus({
    law,
    documents: texts.map((text, index) => ({ name: `Документ ${String(index + 1)}.docx`, text })),
  });
}

describe("detectVatStatus: цена с НДС", () => {
  it.each([
    "Начальная (максимальная) цена контракта составляет 5 400 000 руб. с учетом НДС.",
    "Цена договора включая НДС 20 % — 5 400 000 рублей.",
    "НМЦК 5 400 000 рублей, в том числе НДС 900 000 рублей.",
    "Стоимость работ 5 400 000 руб. в т.ч. НДС.",
    "Стоимость работ 5 400 000 руб. в т. ч. НДС.",
    "Цена контракта 5 400 000 руб., НДС 20%.",
    "Цена контракта 5 400 000 руб. (НДС (20%)).",
    "Цена контракта 5 400 000 руб. (НДС 20 %).",
  ])("«%s» — факт документации, цена с НДС", (text) => {
    const status = detect([text]);
    expect(status.includesVat).toBe(true);
    expect(status.basis).toBe("DOCUMENT");
    expect(status.conflict).toBe(false);
    expect(status.documentName).toBe("Документ 1.docx");
  });

  it("цитата дословная и называет файл", () => {
    const status = detect(["Раздел 1. Общие сведения.\nНМЦК составляет 5 400 000 руб. с учётом НДС.\nРаздел 2."]);
    expect(status.quote).toBe("НМЦК составляет 5 400 000 руб. с учётом НДС");
    expect(status.documentName).toBe("Документ 1.docx");
  });

  it("ставка 22 % (с 2026 года) тоже признак «с НДС»", () => {
    expect(detect(["Цена контракта 5 400 000 руб., НДС 22 %."]).basis).toBe("DOCUMENT");
  });
});

describe("detectVatStatus: цена без НДС", () => {
  it.each([
    "Цена договора 4 500 000 рублей без НДС.",
    "Цена договора 4 500 000 рублей, НДС не облагается.",
    "Цена контракта 4 500 000 руб., НДС не предусмотрен.",
    "Начальная цена 4 500 000 руб. без учета НДС.",
    "Начальная цена 4 500 000 руб. без учёта НДС.",
    "НМЦК БЕЗ УЧЁТА НДС составляет 4 500 000 руб.",
  ])("«%s» — цена без НДС", (text) => {
    const status = detect([text]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
    expect(status.conflict).toBe(false);
    expect(status.quote).not.toBeNull();
  });

  it("«без учета НДС» не считается «с учетом НДС»", () => {
    const status = detect(["Цена контракта указана без учета НДС."]);
    expect(status.includesVat).toBe(false);
    expect(status.conflict).toBe(false);
  });

  it("«без учета НДС 20 %» не принимается за «НДС 20 %»", () => {
    const status = detect(["Цена контракта без учета НДС 20 % составляет 4 500 000 руб."]);
    expect(status.includesVat).toBe(false);
    expect(status.conflict).toBe(false);
  });

  it("«в том числе НДС не облагается» — это «без НДС», а не конфликт", () => {
    const status = detect(["Цена контракта 4 500 000 руб., в том числе НДС не облагается."]);
    expect(status.includesVat).toBe(false);
    expect(status.conflict).toBe(false);
  });
});

describe("detectVatStatus: ё и е, регистр", () => {
  it("«учётом» и «учетом» — одно и то же", () => {
    expect(detect(["Цена с учётом НДС."]).basis).toBe("DOCUMENT");
    expect(detect(["Цена с учетом НДС."]).basis).toBe("DOCUMENT");
    expect(detect(["ЦЕНА С УЧЁТОМ НДС."]).includesVat).toBe(true);
  });
});

describe("detectVatStatus: только рядом с ценой", () => {
  it("«без НДС» вне фрагмента про цену не считается", () => {
    const status = detect(["Штраф рассчитывается без НДС и не облагается налогом."], "FZ_223");
    expect(status.basis).toBe("ASSUMPTION");
    expect(status.quote).toBeNull();
  });

  it("слово про цену в соседнем предложении не считается", () => {
    const status = detect(["Цена контракта фиксированная. Неустойка начисляется без НДС."]);
    expect(status.basis).toBe("ASSUMPTION");
  });

  it("«процент» и «оценка» не принимаются за цену", () => {
    const status = detect(["Оценка заявок: процент снижения считается без НДС."]);
    expect(status.basis).toBe("ASSUMPTION");
  });

  it("сокращение «руб.» не обрывает фрагмент между суммой и «без НДС»", () => {
    const status = detect(["НМЦК составляет 4 500 000 руб. без НДС"]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
  });

  it("границы слов: «безндс» и «подсчетом НДС» не совпадают", () => {
    expect(detect(["Цена: безндс."]).basis).toBe("ASSUMPTION");
    expect(detect(["Цена: подсчетом НДС."]).basis).toBe("ASSUMPTION");
  });
});

describe("detectVatStatus: оба варианта", () => {
  it("в разных документах — конфликт, цитаты нет, для 223-ФЗ допущение", () => {
    const status = detect(["Цена контракта без НДС.", "Цена контракта с учетом НДС."], "FZ_223");
    expect(status).toEqual({
      includesVat: true,
      basis: "ASSUMPTION",
      quote: null,
      documentName: null,
      conflict: true,
    });
  });

  it("для 44-ФЗ конфликт отдаёт основание «закон»", () => {
    const status = detect(["Цена контракта без НДС.", "Цена контракта с учетом НДС."], "FZ_44");
    expect(status.basis).toBe("LAW_44");
    expect(status.includesVat).toBe(true);
    expect(status.conflict).toBe(true);
    expect(status.quote).toBeNull();
  });

  it("в одном предложении тоже конфликт", () => {
    const status = detect(["Цена 4 500 000 руб. без НДС (5 400 000 руб. с учетом НДС)."]);
    expect(status.conflict).toBe(true);
  });
});

describe("detectVatStatus: в документах ничего нет", () => {
  it("44-ФЗ — цена включает налоги по закону, это не факт документации", () => {
    const status = detect(["Цена контракта фиксированная."], "FZ_44");
    expect(status).toEqual({ includesVat: true, basis: "LAW_44", quote: null, documentName: null, conflict: false });
  });

  it("223-ФЗ — допущение", () => {
    const status = detect(["Цена договора фиксированная."], "FZ_223");
    expect(status).toEqual({ includesVat: true, basis: "ASSUMPTION", quote: null, documentName: null, conflict: false });
  });

  it("документов нет вовсе: закон не указан — допущение", () => {
    expect(detect([], null).basis).toBe("ASSUMPTION");
    expect(detect([], undefined).basis).toBe("ASSUMPTION");
    expect(detect([], "FZ_44").basis).toBe("LAW_44");
  });

  it("пустые тексты документов не ломают поиск", () => {
    expect(detect(["", ""], "FZ_44").basis).toBe("LAW_44");
  });

  it("факт из документации сильнее закона: 44-ФЗ, но в документе «без НДС»", () => {
    const status = detect(["Цена контракта без НДС."], "FZ_44");
    expect(status.basis).toBe("DOCUMENT");
    expect(status.includesVat).toBe(false);
  });
});

describe("detectVatStatus: цитата", () => {
  it("длинный фрагмент режется до ~200 знаков вокруг фразы про НДС", () => {
    const filler = "очень длинное описание условий исполнения контракта и порядка расчётов сторон ".repeat(3);
    const status = detect([`Цена контракта ${filler} составляет 5 400 000 руб. с учетом НДС ${filler}`]);
    expect(status.basis).toBe("DOCUMENT");
    expect(status.quote!.length).toBeLessThanOrEqual(202);
    expect(status.quote).toContain("с учетом НДС");
  });

  it("первое совпадение берётся из первого документа по порядку", () => {
    const status = detect(["Цена с учетом НДС (документ первый).", "Цена с учетом НДС (документ второй)."]);
    expect(status.documentName).toBe("Документ 1.docx");
    expect(status.quote).toContain("первый");
  });

  it("переносы строк в цитате схлопываются в пробелы", () => {
    const status = detect(["Цена контракта 5 400 000 руб., в том числе\nНДС 20 %."]);
    expect(status.quote).toBe("Цена контракта 5 400 000 руб., в том числе НДС 20 %");
  });
});

describe("detectVatStatus: большие тексты", () => {
  it("миллион знаков без совпадений обрабатывается мгновенно", () => {
    const text = "Цена контракта определяется в соответствии с условиями договора. ".repeat(20_000);
    const started = Date.now();
    const status = detect([text], "FZ_223");
    expect(status.basis).toBe("ASSUMPTION");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("много совпадений без цены рядом не дают квадратичного времени", () => {
    const text = "Расчёт без НДС. ".repeat(50_000);
    const started = Date.now();
    expect(detect([text]).basis).toBe("ASSUMPTION");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("длинная строка без знаков препинания и пробелов не вешает поиск", () => {
    const text = `${"ц".repeat(500_000)} без ндс ${"ц".repeat(500_000)}`;
    const started = Date.now();
    detect([text]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("совпадение в конце огромного документа находится", () => {
    const text = `${"Общие положения закупки. ".repeat(20_000)}\nНМЦК 4 500 000 руб. без НДС.`;
    const status = detect([text]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
  });
});

describe("detectVatStatus: ложные «факты» из типовых формулировок", () => {
  it("условная оговорка про УСН не доказывает «без НДС» для цены закупки", () => {
    const status = detect([
      "Цена контракта включает все налоги. В случае если подрядчик применяет упрощённую систему налогообложения, цена не облагается НДС.",
    ]);
    expect(status.basis).toBe("ASSUMPTION");
    expect(status.includesVat).toBe(true);
    expect(status.quote).toBeNull();
  });

  it.each([
    "Цена не облагается НДС, если подрядчик применяет УСН.",
    "При условии применения упрощенной системы цена договора не облагается НДС.",
    "Цена договора без НДС при применении подрядчиком УСН.",
    "Цена договора без НДС, если подрядчик освобожден от уплаты НДС.",
    "Цена договора не облагается НДС: подрядчик не является плательщиком НДС.",
  ])("условный фрагмент «%s» пропускается", (text) => {
    expect(detect([text]).basis).toBe("ASSUMPTION");
  });

  it("правило оценки заявок «по цене без учета НДС» — не статус НМЦК", () => {
    const status = detect(["Оценка заявок производится по цене без учета НДС."]);
    expect(status.basis).toBe("ASSUMPTION");
    expect(status.includesVat).toBe(true);
  });

  it.each([
    "Цена, предложенная участниками, при сравнении заявок указывается с учетом НДС.",
    "Сопоставление ценовых предложений проводится по цене без НДС.",
    "При рассмотрении заявок цена принимается с учетом НДС.",
  ])("сравнение и рассмотрение заявок «%s» не считаются ни «с», ни «без»", (text) => {
    expect(detect([text]).basis).toBe("ASSUMPTION");
  });

  it("«кроме того НДС 20 %» — налог сверху, цена без НДС, с цитатой", () => {
    const status = detect(["Цена договора 1 000 000 руб., кроме того НДС 20% — 200 000 руб."]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
    expect(status.conflict).toBe(false);
    expect(status.quote).toContain("кроме того НДС 20%");
  });

  it.each([
    "Цена договора 1 000 000 руб., кроме того, НДС 20 %.",
    "Цена договора 1 000 000 руб. сверх того НДС 20%.",
    "Стоимость работ 1 000 000 руб. плюс НДС 20 %.",
    "Стоимость работ 1 000 000 руб. дополнительно НДС 20 %.",
  ])("«%s» — цена без НДС", (text) => {
    const status = detect([text]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
    expect(status.conflict).toBe(false);
  });

  it("«в т.ч. НДС 20%» после двоеточия — цена с НДС", () => {
    const status = detect(["Начальная (максимальная) цена контракта: 4 500 000,00 рублей, в т.ч. НДС 20%."]);
    expect(status.includesVat).toBe(true);
    expect(status.basis).toBe("DOCUMENT");
    expect(status.conflict).toBe(false);
  });

  it("«Сметная стоимость … НДС не облагается» — цена без НДС", () => {
    const status = detect(["Сметная стоимость работ составляет 1 200 000 руб. НДС не облагается."]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
  });

  it("незаполненный шаблон «в том числе НДС ___ % (или НДС не облагается)» — конфликт", () => {
    const status = detect(["Цена Контракта составляет ____ рублей, в том числе НДС ___ % (или НДС не облагается)."]);
    expect(status.conflict).toBe(true);
    expect(status.quote).toBeNull();
    expect(status.includesVat).toBe(true);
    expect(status.basis).toBe("ASSUMPTION");
  });
});

describe("detectVatStatus: режим участника (УСН) — не факт о цене", () => {
  it("«не облагается НДС в связи с применением УСН» — допущение, а не документация", () => {
    const status = detect(["Цена договора 500 000 руб. (не облагается НДС в связи с применением УСН)."]);
    expect(status.includesVat).toBe(true);
    expect(status.basis).toBe("ASSUMPTION");
    expect(status.quote).toBeNull();
  });

  it("при 44-ФЗ та же оговорка отдаёт основание «закон»", () => {
    const status = detect(["Цена договора 500 000 руб. (не облагается НДС в связи с применением УСН)."], "FZ_44");
    expect(status).toEqual({ includesVat: true, basis: "LAW_44", quote: null, documentName: null, conflict: false });
  });

  it.each([
    "Цена договора 500 000 руб. без НДС (подрядчик на УСН).",
    "Цена договора 500 000 руб. НДС не облагается, подрядчик на УСНО.",
    "Цена договора 500 000 руб. без НДС, поставщик на УСН-доходы.",
  ])("«УСН»/«УСНО» отдельным словом — оговорка: «%s»", (text) => {
    expect(detect([text]).basis).toBe("ASSUMPTION");
  });

  it("«усн» внутри другого слова оговоркой не считается", () => {
    // «усн» внутри слов («Мусный», «грусный») границей слова отсекается.
    const status = detect(["Цена договора 500 000 руб. без НДС. Мусный участок."]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
    const inside = detect(["Цена договора на грусный объект 500 000 руб. без НДС."]);
    expect(inside.basis).toBe("DOCUMENT");
  });

  it("«Сметная стоимость работ … НДС не облагается» по-прежнему факт: цена без НДС", () => {
    const status = detect(["Сметная стоимость работ составляет 1 200 000 руб. НДС не облагается."]);
    expect(status.includesVat).toBe(false);
    expect(status.basis).toBe("DOCUMENT");
  });
});
