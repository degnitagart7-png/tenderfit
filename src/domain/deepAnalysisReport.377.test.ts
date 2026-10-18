import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDeepAnalysisReport,
  type DeepAnalysisReport,
  type ReportBlock,
  type ReportSection,
} from "@/domain/deepAnalysisReport";
import { buildDeepAnalysisDocx } from "@/services/deepAnalysisExport";
import {
  FINDINGS_377,
  NOW_377,
  SUBJECT_377,
  profileMatch377,
  summary377,
  tender377,
} from "@/test/tender377";

/*
  Закупка 0134300025826000377 — тот самый отчёт, который владельцу не понравился:
  15 строк «сверки», из них половина — повторы и обеспечения; сметные цифры в
  рисках; «длительный срок оплаты» при оплате за 7 рабочих дней. Тест держит
  именно этот случай, а не абстрактные правила.
*/

const nbsp = (text: string) => text.replace(/\s/g, " ");

function build(over: Partial<Parameters<typeof buildDeepAnalysisReport>[0]> = {}) {
  return buildDeepAnalysisReport({
    regNumber: "0134300025826000377",
    subject: SUBJECT_377,
    summary: summary377(),
    generatedAt: NOW_377,
    tender: tender377(),
    profileMatch: profileMatch377(),
    ...over,
  });
}

const report: DeepAnalysisReport = build();

const section = (title: string): ReportSection => {
  const found = report.sections.find((s) => s.title === title);
  if (!found) throw new Error(`нет раздела «${title}»`);
  return found;
};

const tableIn = (blocks: ReportBlock[], index = 0) => {
  const tables = blocks.filter((b) => b.kind === "table");
  const table = tables[index];
  if (!table || table.kind !== "table") throw new Error("нет таблицы");
  return table;
};

/** Весь текст раздела одной строкой: ячейки, заметки, абзацы, пункты. */
function textOf(blocks: ReportBlock[]): string {
  return nbsp(
    blocks
      .map((block) => {
        if (block.kind === "paragraph") return block.text;
        if (block.kind === "bullets") return block.items.join("\n");
        return block.rows
          .map((row) =>
            row.map((cell) => [cell.text, cell.detail, cell.note].filter(Boolean).join(" ")).join(" | "),
          )
          .join("\n");
      })
      .join("\n"),
  );
}

const requirements = tableIn(section("Можем ли участвовать").blocks);
const requirementsText = textOf(section("Можем ли участвовать").blocks);
const risksText = textOf(section("Риски договора").blocks);
const estimateText = textOf(section("Смета и цена участия").blocks);

describe("закупка 377: шапка и разделы", () => {
  it("в шапке нет «Модели» и «Состояния разбора»; есть закон, срок подачи и место работ", () => {
    const labels = report.facts.map(([label]) => label);
    expect(labels).toEqual([
      "Заказчик",
      "Закон",
      "НМЦК",
      "Окончание подачи",
      "Место работ",
      "Отчёт сформирован",
    ]);
    const facts = Object.fromEntries(report.facts);
    expect(facts["Закон"]).toBe("44-ФЗ");
    expect(nbsp(facts["НМЦК"]!)).toBe("2 032 153,32 ₽");
    expect(facts["Окончание подачи"]).toMatch(/\(осталось 7 дней\)$/);
    expect(facts["Место работ"]).toMatch(/Братск.*Возрождения.*46/);
  });

  it("порядок разделов; нет «Прочей информации» и «Что сделать»", () => {
    const titles = report.sections.map((s) => s.title);
    expect(titles).toEqual([
      "Итог",
      "Можем ли участвовать",
      "Деньги",
      "Сроки и гарантия",
      "Смета и цена участия",
      "Риски договора",
      "Документы закупки",
      "Важно",
    ]);
    expect(titles).not.toContain("Прочая информация");
    expect(titles).not.toContain("Что сделать");
  });

  it("неоконченный разбор — абзац-предупреждение в «Итоге», а не строка шапки", () => {
    expect(textOf(section("Итог").blocks)).toMatch(/Разбор документации не завершён/);
    expect(JSON.stringify(report.facts)).not.toMatch(/Идёт разбор/);
  });

  it("модель — только мелко в «Важно»", () => {
    expect(JSON.stringify(report.facts)).not.toMatch(/gemini/);
    expect(textOf(section("Важно").blocks)).toMatch(/Разбор выполнен моделью google\/gemini-2\.5-flash\./);
  });
});

describe("закупка 377: таблица «Можем ли участвовать»", () => {
  it("пять колонок в нужном порядке", () => {
    expect(requirements.columns.map((c) => c.title)).toEqual([
      "№",
      "Требование",
      "Статус",
      "Основание",
      "Что делать",
    ]);
    expect(requirements.columns.map((c) => c.width)).toEqual([5, 25, 16, 28, 26]);
    for (const row of requirements.rows) expect(row).toHaveLength(5);
  });

  it("из 15 строк остаётся 5: СМП, техника, опыт, специалисты, типовые", () => {
    expect(requirements.rows.map((r) => r[1]!.text)).toEqual([
      "Только для малого бизнеса (СМП, СОНКО)",
      "Наличие техники, оборудования, технологий и материалов, прошедших осмотр и сертификацию",
      expect.stringMatching(/^Опыт: исполненный договор на ремонт зданий или строительство, сумма от 406.430,66.₽ \(20.%.НМЦК\)$/),
      "Наличие квалифицированных специалистов",
      "Типовые требования (ч. 1 ст. 31 44-ФЗ, санкционные перечни)",
    ]);
  });

  it("порядок: Не выполнено → Проверить → Выполнено", () => {
    expect(requirements.rows.map((r) => r[2]!.text)).toEqual([
      "Проверить",
      "Проверить",
      "Выполнено",
      "Выполнено",
      "Выполнено",
    ]);
    expect(requirements.rows[0]![2]).toMatchObject({ tone: "warn", bold: true });
    expect(requirements.rows[2]![2]).toMatchObject({ tone: "good", bold: true });
  });

  it("гарантия 36 мес. и обеспечение гарантии — не в требованиях допуска", () => {
    expect(requirementsText).not.toMatch(/36 мес/);
    expect(requirementsText).not.toMatch(/Гарантия на выполненные работы/);
    expect(requirementsText).not.toMatch(/Гарантийные обязательства/);
    expect(requirementsText).not.toMatch(/Обеспечение гарантийных/);
    expect(requirementsText).not.toMatch(/203.215/);
    // Гарантия — один раз, в «Сроки и гарантия»; обеспечение гарантии — один раз, в «Деньги».
    const terms = tableIn(section("Сроки и гарантия").blocks);
    expect(terms.rows.filter((r) => /Гарантия на работы/.test(r[0]!.text))).toHaveLength(1);
    expect(terms.rows.find((r) => /Гарантия на работы/.test(r[0]!.text))![1]!.text).toBe("36 мес.");
    const money = tableIn(section("Деньги").blocks);
    expect(money.rows.filter((r) => /Обеспечение гарантийных обязательств/.test(r[0]!.text))).toHaveLength(1);
    expect(nbsp(money.rows.find((r) => /гарантийных/.test(r[0]!.text))![1]!.text)).toMatch(/^203 215,33 ₽/);
  });

  it("обеспечения и «способ обеспечения» — не в требованиях, а в «Деньги»", () => {
    expect(requirementsText).not.toMatch(/Способ обеспечения/);
    expect(requirementsText).not.toMatch(/Обеспечение (заявки|исполнения)/);
    expect(requirementsText).not.toMatch(/Специальный счёт/);
    const money = textOf(section("Деньги").blocks);
    expect(money).toMatch(/Способ обеспечения \| Независимая гарантия или деньги/);
  });

  it("опыт: «Что делать» называет сумму 406 430,66 ₽", () => {
    const row = requirements.rows[2]!;
    expect(nbsp(row[4]!.text)).toContain("406 430,66 ₽");
    expect(row[4]!.text).toMatch(/^Ничего: по профилю опыт есть\. Приложите к заявке договор и акт/);
  });

  it("«Что делать» — конкретное действие, фразы «автоматически не сверяется» нет нигде", () => {
    expect(requirements.rows[0]![4]!.text).toBe(
      "Проверьте, что компания есть в реестре МСП (rmsp.nalog.ru). Если нет — участвовать нельзя.",
    );
    expect(requirements.rows[4]![4]!.text).toBe("Подтверждается декларацией в заявке.");
    expect(JSON.stringify(report)).not.toMatch(/[Аа]втоматически не сверяется/);
  });

  it("основание — цитата до ~180 знаков по границе слова и раздел мелко ниже", () => {
    const basis = requirements.rows[2]![3]!;
    expect(basis.text.startsWith("«Наличие у участника закупки")).toBe(true);
    expect(basis.text.endsWith("…»")).toBe(true);
    expect(basis.text.length).toBeLessThanOrEqual(184);
    expect(basis.note).toBe("— Преимущества и требования к участникам");
    // Источники свёрнутой строки типовых требований — через «; » без повтора.
    expect(requirements.rows[4]![3]!.note).toBe("— Преимущества и требования к участникам");
  });
});

describe("закупка 377: «Деньги» и «Сроки»", () => {
  const money = tableIn(section("Деньги").blocks);
  const row = (name: RegExp) => {
    const found = money.rows.find((r) => name.test(r[0]!.text));
    if (!found) throw new Error(`нет строки ${String(name)}`);
    return { sum: nbsp(found[1]!.text), note: nbsp(found[2]!.text) };
  };

  it("таблица: Показатель | Сумма | Пояснение", () => {
    expect(money.columns.map((c) => c.title)).toEqual(["Показатель", "Сумма", "Пояснение"]);
  });

  it("суммы посчитаны кодом: заявка, исполнение (с ×1,5), гарантия", () => {
    expect(row(/^НМЦК$/).sum).toBe("2 032 153,32 ₽");
    expect(row(/заявки/).sum).toBe("20 321,53 ₽ (1 % НМЦК)");
    expect(row(/заявки/).note).toMatch(/до подведения итогов/);
    expect(row(/исполнения/).sum).toBe("609 646,00 ₽ (30 % НМЦК)");
    expect(row(/исполнения/).note).toMatch(/в 1,5 раза больше: 45 % НМЦК = 914 468,99 ₽/);
    expect(row(/гарантийных/).sum).toBe("203 215,33 ₽ (10 % НМЦК)");
    expect(row(/Срок оплаты/).sum).toBe("7 рабочих дн.");
  });

  it("аванс не выдуман: в данных его нет — строки нет", () => {
    expect(money.rows.some((r) => /Аванс/.test(r[0]!.text))).toBe(false);
    expect(money.rows.some((r) => /Казначейск/.test(r[0]!.text))).toBe(false);
  });

  it("итог: сколько заморозится — в «Деньгах» и в «Итоге»", () => {
    const expected =
      "Заморозится на время контракта: до 1 117 684,32 ₽ (исполнение + гарантия); плюс заявка 20 321,53 ₽ до итогов.";
    expect(textOf(section("Деньги").blocks)).toContain(expected);
    expect(textOf(section("Итог").blocks)).toContain(expected);
  });

  it("если реквизитов нет — суммы всё равно берутся из находок", () => {
    const bare = tender377();
    bare.financial = {
      ...bare.financial,
      bidSecurityAmount: null,
      contractSecurityPercent: null,
    };
    const text = textOf(section("Деньги").blocks);
    const fromFindings = textOf(
      build({ tender: bare }).sections.find((s) => s.title === "Деньги")!.blocks,
    );
    expect(fromFindings).toContain("20 321,53 ₽");
    expect(fromFindings).toContain("609 646,00 ₽");
    expect(fromFindings).toBe(text);
  });

  it("сроки: подача, работы до 30 ноября — «сжатый срок», исполнение контракта, гарантия", () => {
    const terms = tableIn(section("Сроки и гарантия").blocks);
    expect(terms.rows.map((r) => r[0]!.text)).toEqual([
      "Подача заявок",
      "Выполнение работ",
      "Исполнение контракта",
      "Гарантия на работы",
    ]);
    expect(terms.rows[1]![1]!.text).toBe("до 30 ноября 2026 г.");
    expect(terms.rows[1]![2]!.text).toMatch(/сжатый срок: проверьте, успеете ли/);
    expect(terms.rows[1]![2]).toMatchObject({ tone: "warn" });
    expect(terms.rows[2]![1]!.text).toBe("до 23 декабря 2026 г.");
  });
});

describe("закупка 377: риски договора", () => {
  const table = tableIn(section("Риски договора").blocks);

  it("пять колонок; строками — только высокие и средние", () => {
    expect(table.columns.map((c) => c.title)).toEqual([
      "№",
      "Риск",
      "Важность",
      "Основание",
      "Что делать",
    ]);
    expect(table.rows.map((r) => r[1]!.text)).toEqual([
      "Право Заказчика на односторонний отказ от Контракта",
      "Штраф за неисполнение или ненадлежащее исполнение обязательств Подрядчиком",
      "Пеня за просрочку исполнения обязательств Подрядчиком",
    ]);
    expect(table.rows.map((r) => r[2]!.text)).toEqual(["Высокая", "Средняя", "Средняя"]);
  });

  it("«односторонний отказ» — один раз; склеенные источники через «; »", () => {
    expect(risksText.match(/односторонн/gi)?.length).toBeGreaterThan(0);
    expect(table.rows.filter((r) => /односторонн/i.test(r[1]!.text))).toHaveLength(1);
    expect(table.rows[0]![3]!.note).toBe("— 8. Порядок изменения и расторжения Контракта; Условия контрактов");
  });

  it("НДС 22 %, индекс инфляции, непредвиденные — не в рисках, а в «Смете»", () => {
    expect(risksText).not.toMatch(/НДС/);
    expect(risksText).not.toMatch(/инфляци/);
    expect(risksText).not.toMatch(/Непредвиденн/);
    expect(estimateText).toMatch(/НДС 22%/);
    expect(estimateText).toMatch(/индекс прогнозной инфляции/);
    expect(estimateText).toMatch(/непредвиденные затраты/);
  });

  it("«Длительный срок оплаты» (7 рабочих дней) и «Длительный срок выполнения» (до 30 ноября) убраны", () => {
    expect(risksText).not.toMatch(/Длительный срок оплаты/);
    expect(risksText).not.toMatch(/Длительный срок выполнения/);
    expect(textOf(report.sections.flatMap((s) => s.blocks))).not.toMatch(/Длительный срок/);
  });

  it("«Что делать» — конкретно, с числами из цитаты", () => {
    expect(table.rows[0]![4]!.text).toMatch(/запас.*5 календарных дней.*расторгнуть/);
    expect(table.rows[2]![4]!.text).toMatch(/пени 1\/300 ключевой ставки/);
    expect(nbsp(table.rows[1]![4]!.text)).toMatch(/Штраф 1 % цены контракта.*20 321,53 ₽/);
  });

  it("«чем грозит» — отдельным абзацем под названием, цитата — не длиннее ~180 знаков", () => {
    expect(table.rows[0]![1]!.detail).toMatch(/^Заказчик вправе в одностороннем порядке/);
    for (const row of table.rows) expect(row[3]!.text.length).toBeLessThanOrEqual(184);
  });

  it("низкие — одной строкой в конце", () => {
    const blocks = section("Риски договора").blocks;
    expect(blocks.at(-1)).toMatchObject({
      kind: "paragraph",
      small: true,
      text: "Ещё 1 условие низкой важности: Штраф за неисполнение обязательств Подрядчиком.",
    });
  });
});

describe("закупка 377: смета и прочее", () => {
  it("смета не рассчитана — короткая заглушка; ниже «Из документации заказчика»", () => {
    expect(estimateText).toMatch(
      /^Смета не рассчитана\. Нажмите «Рассчитать смету» в карточке закупки — посчитаем стоимость по ценам Минстроя/,
    );
    expect(estimateText).toMatch(/Из документации заказчика/);
    for (const topic of [
      /ресурсно-индексным/,
      /Ведомость объемов работ/,
      /1 625 720/,
      /557 750/,
      /591\.97/,
      /повышающие коэффициенты/,
      /мусора/,
    ]) {
      expect(estimateText).toMatch(topic);
    }
  });

  it("сметные сведения — одной строкой, без повтора «уровня цен»", () => {
    const bullets = section("Смета и цена участия").blocks.filter((b) => b.kind === "bullets");
    const items = bullets.flatMap((b) => (b.kind === "bullets" ? b.items : []));
    expect(items.filter((i) => /уровн\S* цен/.test(i))).toHaveLength(1);
    for (const item of items) expect(item.length).toBeLessThanOrEqual(240);
  });

  it("предмет закупки и НМЦК не повторяются в сведениях", () => {
    const all = textOf(report.sections.flatMap((s) => s.blocks));
    expect(all).not.toMatch(/Предмет закупки —/);
    expect(all).not.toMatch(/Начальная \(максимальная\) цена контракта составляет/);
  });
});

describe("закупка 377: итог не противоречит таблице", () => {
  const conclusion = section("Итог").blocks;
  const verdict = conclusion[0]!;

  it("в таблице нет «Не выполнено» — итог не говорит «Нет»", () => {
    expect(requirements.rows.some((r) => r[2]!.text === "Не выполнено")).toBe(false);
    expect(verdict.kind === "paragraph" && verdict.text).toMatch(/^Да, если подтвердите:/);
    expect(verdict).toMatchObject({ tone: "warn" });
  });

  it("условия — ровно то, что в таблице «Проверить»; «Выполнено» (опыт, специалисты) блокером не назван", () => {
    const text = verdict.kind === "paragraph" ? verdict.text : "";
    expect(text).toMatch(/реестре МСП/);
    expect(text).toMatch(/техники/);
    expect(text).not.toMatch(/договор/);
    expect(text).not.toMatch(/специалист/);
    expect(text).not.toMatch(/406/);
  });

  it("три главных действия, затем деньги и непрочитанные файлы с причинами", () => {
    const bullets = conclusion.find((b) => b.kind === "bullets");
    if (!bullets || bullets.kind !== "bullets") throw new Error("нет списка");
    expect(bullets.items).toHaveLength(3);
    expect(bullets.items[0]).toMatch(/реестре МСП/);
    const text = textOf(conclusion);
    expect(text).toMatch(/Заморозится на время контракта/);
    expect(text).toMatch(
      /Прочитано 7 из 9 файлов\. Не прочитаны: «Приложение № 4 к МК и №3 к ТЗ Схема\.pdf» — в файле нет текста/,
    );
    expect(text).toMatch(/Ведомость объемов работ\.odt» — формат \.odt сервис пока не читает/);
  });

  it("итог — не больше шести абзацев и пунктов вместе с действиями", () => {
    const lines = conclusion.reduce(
      (n, block) => n + (block.kind === "bullets" ? block.items.length : 1),
      0,
    );
    expect(lines).toBeLessThanOrEqual(9);
  });
});

describe("закупка 377: документы", () => {
  it("«Прочитано 7 из 9», таблица пропущенных простыми словами, прочитанные — отдельно", () => {
    const blocks = section("Документы закупки").blocks;
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "Прочитано 7 из 9" });
    const skipped = tableIn(blocks, 0);
    expect(skipped.columns.map((c) => c.title)).toEqual(["Файл", "Почему не прочитан", "Что делать"]);
    expect(skipped.rows).toHaveLength(2);
    expect(skipped.rows[1]![1]!.text).toBe("Формат .odt сервис пока не читает.");
    expect(skipped.rows[1]![2]!.text).toMatch(/^Откройте файл вручную/);
    const read = tableIn(blocks, 1);
    expect(read.rows).toHaveLength(7);
    expect(read.rows[2]![1]!.note).toBe("Внутри архива прочитано 2 из 2");
  });
});

describe("закупка 377: профиль не заполнен", () => {
  const noProfile = build({ profileMatch: null });

  it("та же таблица из 5 колонок со статусом «Проверить» и приглашением заполнить профиль", () => {
    const blocks = noProfile.sections.find((s) => s.title === "Можем ли участвовать")!.blocks;
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      text: "Заполните профиль компании — отчёт сам отметит, что выполнено.",
    });
    const table = tableIn(blocks);
    expect(table.columns).toHaveLength(5);
    expect(new Set(table.rows.map((r) => r[2]!.text))).toEqual(new Set(["Проверить"]));
    // Те же чистки: гарантия и обеспечения не в таблице.
    expect(nbsp(JSON.stringify(table.rows))).not.toMatch(/Обеспечение|36 мес/);
    const experience = table.rows.find((r) => /^Опыт/.test(r[1]!.text))!;
    expect(nbsp(experience[4]!.text)).toContain("406 430,66 ₽");
  });
});

/*
  Файл для глаз ревьюера: тот же код экспорта, что и в приложении. Пишется только
  по запросу — в обычном прогоне тестов на диск ничего не попадает.
*/
describe("закупка 377: файл Word", () => {
  it("собирается в настоящий .docx", async () => {
    const bytes = await buildDeepAnalysisDocx({
      regNumber: "0134300025826000377",
      subject: SUBJECT_377,
      summary: summary377(),
      generatedAt: NOW_377,
      tender: tender377(),
      profileMatch: profileMatch377(),
    });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const out = process.env["REPORT_377_DOCX"];
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
    }
  });

  it("находок в фикстуре столько же, сколько в исходном отчёте: 15 + 10 + 14", () => {
    expect(FINDINGS_377).toHaveLength(39);
  });
});
