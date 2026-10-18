import { describe, expect, it } from "vitest";

import { applyBillEdits, type BillEdit } from "@/domain/estimate/billEdits";
import { buildRowInfos, matchBadge } from "@/domain/estimate/billReview";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { collectNormCandidates, type NormPickCandidate } from "@/domain/estimate/normCandidates";
import { CANDIDATE_NORMS, CUSTOMER_NORM_KEYS } from "@/domain/estimate/normCandidates.fixtures";
import {
  applyNormPick,
  buildNormPickPrompt,
  checkPick,
  demolitionCoefficients,
  lexicalCoverage,
  MIN_PICK_COVERAGE,
  needsNormPick,
  normPickMaxTokens,
  normPickRequestSchema,
  parseNormPickResponse,
  stripAiNormPick,
  withAiDemolition,
  type NormPickItem,
} from "@/domain/estimate/normPick";
import type { BillOfWorkItem, EstimateLine, NormRecord } from "@/domain/estimate/types";
import { makeBillItem } from "@/test/estimateFixtures";

/**
 * «ИИ-сметчик», чистая часть: проверка ответа модели, коэффициенты на демонтаж, запись выбора в позицию, промпт и схема запроса.
 *
 * Принцип проверок: ответ модели ничего не значит, пока код не убедился, что шифр был среди кандидатов, норма есть в базе, а единица
 * переводится из единицы позиции. Деньги от выбора модели зависят напрямую, поэтому отказ дешевле ошибки.
 */

const INDEX = createNormSearchIndex(CANDIDATE_NORMS);
const norm = (key: string): NormRecord => {
  const found = INDEX.byKey.get(key);
  if (found === undefined) throw new Error(`в корпусе нет ${key}`);
  return found;
};

const cand = (key: string): Pick<NormPickCandidate, "key"> => ({ key });

/** Позиция ведомости без шифра: вход «ИИ-сметчика». */
const bill = (patch: Partial<BillOfWorkItem> = {}): BillOfWorkItem =>
  makeBillItem({
    workName: "Демонтаж оконных откосов",
    quantity: 120,
    quantityUnit: "м2",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    ...patch,
  });

describe("parseNormPickResponse", () => {
  it("читает объект items, ограждение ``` и голый массив", () => {
    const answer = '[{"id":"1","pick":"ГЭСН|15-01-070-01","demolition":true,"confidence":"high","reason":"откосная планка"}]';
    const fenced = parseNormPickResponse(`\`\`\`json\n{"items": ${answer}}\n\`\`\``);
    expect(fenced.picks).toEqual([{ id: "1", pick: "ГЭСН|15-01-070-01", demolition: true, confidence: "high", reason: "откосная планка" }]);
    expect(parseNormPickResponse(answer).picks).toHaveLength(1);
  });

  it("null, пустая строка и «нет» — «нормы нет»; числовой id приводится к строке; нет уверенности — null", () => {
    const parsed = parseNormPickResponse(
      JSON.stringify({ items: [{ id: 2, pick: null, reason: "нет" }, { id: "3", pick: "", demolition: false }, { id: "4", pick: "нет", confidence: "средняя" }] }),
    );
    expect(parsed.picks.map((pick) => pick.pick)).toEqual([null, null, null]);
    expect(parsed.picks[0]).toMatchObject({ id: "2", demolition: false, confidence: null });
    expect(parsed.picks[2]?.confidence).toBe("low");
  });

  it("кривой элемент стоит одной позиции, а не пачки; считается числом", () => {
    const parsed = parseNormPickResponse(JSON.stringify({ items: [{ pick: "ГЭСН|1" }, { id: "1", pick: null }, "мусор", null] }));
    expect(parsed.picks).toHaveLength(1);
    expect(parsed.malformed).toBe(3);
  });

  it("не JSON и ответ без списка — ошибка с началом ответа", () => {
    expect(() => parseNormPickResponse("Извините, не могу")).toThrow(/не JSON/);
    expect(() => parseNormPickResponse('{"ok": true}')).toThrow(/items/);
  });
});

describe("checkPick: ответ модели проверяется кодом", () => {
  const candidates = [cand("ГЭСН|15-01-070-01"), cand("ГЭСНр|66-01-024-02")];

  it("null — не отказ, а «нормы нет»", () => {
    expect(checkPick(null, candidates, INDEX, ["м2"])).toEqual({ status: "NONE" });
  });

  it("шифр, которого не было среди отправленных кандидатов, отклоняется — даже если он есть в базе", () => {
    const outside = checkPick("ГЭСН|26-01-066-01", candidates, INDEX, ["м2"]);
    expect(outside).toMatchObject({ status: "REJECTED" });
    expect((outside as { reason: string }).reason).toContain("вне списка кандидатов");
  });

  it("выдуманный шифр отклоняется как вне списка", () => {
    expect(checkPick("ГЭСН|99-99-999-99", candidates, INDEX, ["м2"])).toMatchObject({ status: "REJECTED" });
  });

  it("шифр из списка, которого нет в базе, отклоняется (список подменили)", () => {
    const result = checkPick("ГЭСН|77-01-001-01", [cand("ГЭСН|77-01-001-01")], INDEX, ["м2"]);
    expect(result).toMatchObject({ status: "REJECTED" });
    expect((result as { reason: string }).reason).toContain("нет в базе");
  });

  it("единица нормы не переводится из единицы позиции — отказ с причиной", () => {
    // ГЭСНр 66-01-024-02 — «100 м2»; позиция в тоннах.
    const result = checkPick("ГЭСНр|66-01-024-02", candidates, INDEX, ["т"]);
    expect(result).toMatchObject({ status: "REJECTED" });
    expect((result as { reason: string }).reason).toContain("«100 м2» не переводится из единицы позиции «т»");
  });

  it("у парного объёма («м3/т») подходит любая из величин", () => {
    expect(checkPick("ГЭСНр|66-01-024-02", candidates, INDEX, ["т", "м2"])).toMatchObject({ status: "ACCEPTED" });
  });

  it("принятый выбор возвращает запись нормы", () => {
    const result = checkPick("ГЭСН|15-01-070-01", candidates, INDEX, ["м2"]);
    expect(result).toMatchObject({ status: "ACCEPTED" });
    expect((result as { norm: NormRecord }).norm.code).toBe("15-01-070-01");
  });
});

describe("коэффициенты на демонтаж по норме на устройство (571/пр, п. 83, таблица 2)", () => {
  it("металл: откосная планка из оцинкованной стали — строка 4 (×0,7), материалы не учитываются", () => {
    const outcome = demolitionCoefficients(norm("ГЭСН|15-01-070-01"), "Демонтаж оконных откосов");
    expect(outcome.special).toMatchObject({ id: "M571-P83-T2-R4", labour: 0.7, machines: 0.7, materials: 0, valueVerified: true });
    expect(outcome.unresolved).toBeUndefined();
    expect(outcome.special?.label).toContain("571/пр");
    expect(outcome.special?.label).toContain("не из сметы заказчика");
  });

  it("сборник называет материал сам: деревянные конструкции (10) — строка 2, сборные железобетонные (07) — строка 1", () => {
    const base = norm("ГЭСН|15-01-070-01");
    expect(demolitionCoefficients({ ...base, collectionCode: "10", fullName: "Устройство настила" }, "Демонтаж настила").special?.id).toBe("M571-P83-T2-R2");
    expect(demolitionCoefficients({ ...base, collectionCode: "07", fullName: "Монтаж плит" }, "Демонтаж плит").special?.id).toBe("M571-P83-T2-R1");
  });

  it("системы (отопление, 18) — строка 3, наружные сети (водопровод, 22) — строка 5", () => {
    const base = norm("ГЭСН|15-01-070-01");
    expect(demolitionCoefficients({ ...base, collectionCode: "18", fullName: "Прокладка труб" }, "Демонтаж труб").special).toMatchObject({ id: "M571-P83-T2-R3", labour: 0.4 });
    expect(demolitionCoefficients({ ...base, collectionCode: "22", fullName: "Прокладка труб" }, "Демонтаж труб").special).toMatchObject({ id: "M571-P83-T2-R5", labour: 0.6 });
  });

  it("материал неоднозначен (дерево и металл в одной работе) или не назван — строка не выбирается, ставится «проверьте»", () => {
    const base = { ...norm("ГЭСН|15-01-070-01"), collectionCode: "15", fullName: "Устройство обшивки" };
    const mixed = demolitionCoefficients(base, "Демонтаж деревянных стоек и металлических уголков");
    expect(mixed.special).toBeUndefined();
    expect(mixed.unresolved).toContain("неоднозначна");
    expect(demolitionCoefficients(base, "Демонтаж обшивки").unresolved).toBeDefined();
  });

  it("ГЭСНм — таблица 3 (оборудование), строку по ведомости не выбрать; ГЭСНр и ГЭСНп таблица 2 не покрывает", () => {
    const base = norm("ГЭСН|15-01-070-01");
    expect(demolitionCoefficients({ ...base, baseType: "ГЭСНм" }, "Демонтаж насоса")).toMatchObject({ unresolved: expect.stringContaining("таблицы 3") });
    expect(demolitionCoefficients({ ...base, baseType: "ГЭСНр" }, "Демонтаж")).toMatchObject({ unresolved: expect.stringContaining("ГЭСНр") });
    expect(demolitionCoefficients({ ...base, baseType: "ГЭСНп" }, "Демонтаж").special).toBeUndefined();
  });

  it("норма сама называет разборку или замену — коэффициентов нет и «проверьте» не нужно: демонтаж в ней уже есть", () => {
    const outcome = demolitionCoefficients(norm("ГЭСНр|63-03-007-02"), "Демонтаж профлиста");
    expect(outcome.special).toBeUndefined();
    expect(outcome.unresolved).toBeUndefined();
    expect(outcome.note).toContain("уже включает");
    expect(demolitionCoefficients(norm("ГЭСНр|66-01-024-02"), "Демонтаж утеплителя").special).toBeUndefined();
  });
});

describe("applyNormPick: запись выбора в позицию", () => {
  const pick = { demolition: false, confidence: "high" as const, reason: "ветро-гидрозащита вентилируемого фасада." };

  it("шифр и книга нормы кладутся в позицию, пометка несёт обоснование без точки", () => {
    const item = applyNormPick(bill({ workName: "Снятие ветрозащитной мембраны" }), norm("ГЭСН|26-01-066-01"), pick, null);
    expect(item).toMatchObject({ normCode: "26-01-066-01", normBaseType: "ГЭСН" });
    expect(item.aiNormPick).toMatchObject({ reason: "ветро-гидрозащита вентилируемого фасада", confidence: "high", review: false, demolition: false });
    expect(item.aiNormPick?.note).toBe("норма подобрана ИИ: ветро-гидрозащита вентилируемого фасада");
    expect(item.aiNormPick?.special).toBeUndefined();
  });

  it("demolition=true по металлической норме — в пометке строка 571/пр, коэффициенты готовы к применению, «проверьте» нет", () => {
    const item = applyNormPick(bill(), norm("ГЭСН|15-01-070-01"), { ...pick, demolition: true, reason: "откосы — облицовка планкой" }, null);
    expect(item.aiNormPick?.special?.id).toBe("M571-P83-T2-R4");
    expect(item.aiNormPick?.review).toBe(false);
    expect(item.aiNormPick?.note).toContain("571/пр п. 83, таблица 2, строка 4");
  });

  it("«проверьте»: уверенность low", () => {
    const item = applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), { ...pick, confidence: "low" }, null);
    expect(item.aiNormPick).toMatchObject({ review: true, confidence: "low" });
    expect(item.aiNormPick?.note).toContain("модель не уверена");
  });

  it("«проверьте»: демонтаж по норме на устройство, а строка таблицы 571/пр не определена", () => {
    const base = { ...norm("ГЭСН|15-01-070-01"), collectionCode: "15", fullName: "Устройство обшивки" };
    const item = applyNormPick(bill({ workName: "Демонтаж обшивки" }), base, { ...pick, demolition: true }, null);
    expect(item.aiNormPick?.review).toBe(true);
    expect(item.aiNormPick?.special).toBeUndefined();
  });

  it("«проверьте»: уверенность не названа, а слов работы в норме почти нет; назвала «high» — низкое покрытие не повод", () => {
    const silent = { ...pick, confidence: null };
    expect(applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), silent, MIN_PICK_COVERAGE - 0.01).aiNormPick).toMatchObject({ review: true, confidence: "low" });
    expect(applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), silent, 0.8).aiNormPick?.review).toBe(false);
    expect(applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), pick, 0.01).aiNormPick?.review).toBe(false);
  });

  it("«проверьте»: позиция из сметы заказчика по ТСН-2001 — подбор по смыслу чужой базы всегда на сверку", () => {
    const item = applyNormPick(bill({ foreignBase: "TSN_2001_MOSCOW" }), norm("ГЭСН|26-01-066-01"), pick, null);
    expect(item.aiNormPick?.review).toBe(true);
  });

  it("покрытие слов работы считается тем же поиском, что подбор по наименованию", () => {
    expect(lexicalCoverage(INDEX, "ветро-гидрозащита вентилируемого фасада", norm("ГЭСН|26-01-066-01"))).toBeGreaterThan(0.9);
    expect(lexicalCoverage(INDEX, "Демонтаж профлиста", norm("ГЭСНр|63-03-007-02"))).toBeLessThan(MIN_PICK_COVERAGE);
  });
});

describe("withAiDemolition / stripAiNormPick", () => {
  const picked = applyNormPick(bill(), norm("ГЭСН|15-01-070-01"), { demolition: true, confidence: "high", reason: "откосы" }, null);

  it("коэффициенты из выбора ИИ становятся условиями позиции, включёнными по умолчанию", () => {
    const item = withAiDemolition(picked);
    expect(item.customerConditions).toMatchObject({
      confirmed: null,
      enabled: true,
      forceUnconfirmed: false,
      special: { id: "M571-P83-T2-R4", labour: 0.7, machines: 0.7, materials: 0 },
    });
    expect(item.customerConditions?.label).toContain("571/пр");
  });

  it("позиция без выбора ИИ или без коэффициентов не меняется; повторный вызов ничего не добавляет", () => {
    const plain = bill();
    expect(withAiDemolition(plain)).toBe(plain);
    const once = withAiDemolition(picked);
    expect(withAiDemolition(once)).toBe(once);
  });

  it("норму выбрал человек — пометка ИИ и коэффициенты, выбранные для нормы модели, снимаются", () => {
    const stripped = stripAiNormPick(withAiDemolition(picked));
    expect(stripped.aiNormPick).toBeUndefined();
    expect(stripped.customerConditions).toBeUndefined();
    const plain = bill();
    expect(stripAiNormPick(plain)).toBe(plain);
  });
});

describe("needsNormPick: кому нужен выбор", () => {
  it("работа без шифра — да", () => {
    expect(needsNormPick(bill())).toBe(true);
  });

  it("шифр в позиции или подсказка шифра из документа — нет: шифр документа сильнее модели", () => {
    expect(needsNormPick(bill({ normCode: "15-01-070-01", normBaseType: "ГЭСН" }))).toBe(false);
    expect(needsNormPick(bill({ normCodeHint: { raw: "ГЭСН15-01-070-01", code: "15-01-070-01", baseType: "ГЭСН" } }))).toBe(false);
  });

  it("поставка по справочнику, услуга перевозки, оборудование по цене заказчика, своя цена, вычет и остаток ЛСР — нет", () => {
    expect(needsNormPick(bill({ resourceCode: "07.2.07.12-0068" }))).toBe(false);
    expect(needsNormPick(bill({ workName: "Погрузка мусора в автотранспорт" }))).toBe(false);
    expect(needsNormPick(bill({ serviceRow: true }))).toBe(false);
    expect(needsNormPick(bill({ customerPriceOnly: true }))).toBe(false);
    expect(needsNormPick(bill({ ownUnitPrice: 100 }))).toBe(false);
    expect(needsNormPick(bill({ deduction: true }))).toBe(false);
    expect(needsNormPick(bill({ unaccountedOf: "item-0" }))).toBe(false);
  });

  it("позиция, которой выбор уже сделан, повторно не отправляется", () => {
    const picked = applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), { demolition: false, confidence: "high", reason: "x" }, null);
    expect(needsNormPick(picked)).toBe(false);
  });
});

describe("подпись в таблице «Ведомость и нормы»", () => {
  const line = (code: string, book: string): EstimateLine => ({ itemId: "item-1", normCode: code, normBaseType: book, resources: [] }) as unknown as EstimateLine;

  it("норма от ИИ — основа AI: подпись «подобрано ИИ», обоснование под ней, «проверьте» только по признаку выбора", () => {
    const sure = applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), { demolition: false, confidence: "high", reason: "вентфасад" }, null);
    const doubtful = applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), { demolition: false, confidence: "low", reason: "вентфасад" }, null);
    for (const [item, review] of [[sure, false], [doubtful, true]] as const) {
      const [info] = buildRowInfos({ items: [item], lines: new Map([["item-1", line("26-01-066-01", "ГЭСН")]]), index: INDEX });
      expect(info).toMatchObject({ basis: "AI", review, coverage: null });
      const badge = matchBadge(info, line("26-01-066-01", "ГЭСН"));
      expect(badge.text).toBe(review ? "подобрано ИИ · проверьте" : "подобрано ИИ");
      expect(badge.review).toBe(review);
      expect(badge.note).toContain("норма подобрана ИИ: вентфасад");
    }
  });

  it("норма, выбранная человеком после ИИ, подписывается «выбрано вами»", () => {
    const manual = stripAiNormPick(applyNormPick(bill(), norm("ГЭСН|26-01-066-01"), { demolition: false, confidence: "high", reason: "x" }, null));
    const [info] = buildRowInfos({ items: [manual], lines: new Map([["item-1", line("26-01-066-01", "ГЭСН")]]), index: INDEX, manualNorm: new Set(["item-1"]) });
    expect(info?.basis).toBe("MANUAL");
  });
});

describe("промпт и схема запроса", () => {
  const items: NormPickItem[] = Object.entries(CUSTOMER_NORM_KEYS).map(([workName], position) => ({
    id: String(position + 1),
    workName,
    quantity: 120.5,
    unit: workName.includes("планки") ? "м" : "м2",
    remark: position === 0 ? "*В целях доступа к профлисту. b = 300 мм" : null,
    section: position < 4 ? "Демонтажные работы" : "Монтажные работы",
    candidates: collectNormCandidates(INDEX, { workName, units: [workName.includes("планки") ? "м" : "м2"], section: null }),
  }));
  const batch = { context: { regNumber: "0134300025826000377", subject: "Ремонт фасада" }, items };

  it("промпт называет роль, Методики 421/пр и 571/пр, правила выбора и формат ответа", () => {
    const prompt = buildNormPickPrompt(batch);
    expect(prompt).toContain("аттестованный сметчик");
    expect(prompt).toContain("421/пр");
    expect(prompt).toContain("571/пр");
    expect(prompt).toContain("demolition=true");
    expect(prompt).toContain("pick=null");
    expect(prompt).toContain("Закупка № 0134300025826000377");
    expect(prompt).toContain('{"items": [{"id": "1"');
  });

  it("каждая позиция печатается с объёмом, разделом, примечанием и кандидатами, сгруппированными по таблицам", () => {
    const prompt = buildNormPickPrompt(batch);
    expect(prompt).toContain("### Позиция 1\nРабота: Демонтаж оконных откосов\nОбъём: 120,5 м2\nРаздел ведомости: Демонтажные работы\nПримечание: *В целях доступа к профлисту");
    // Название таблицы и состав работ печатаются один раз, шифры строк — каждый.
    expect(prompt.match(/ГЭСНр 63-03-007 «/g)?.length).toBeGreaterThanOrEqual(1);
    expect(prompt).toContain("ГЭСНр|63-03-007-02 | от 1 м2 до 5 м2 | ед. 100 м2");
    expect(prompt).toContain("  Состав: Выгрузка и перемещение материалов");
    expect(prompt).toContain("ГЭСН|26-01-066-01 | (единственная строка таблицы) | ед. 1000 м2");
  });

  it("пачка из шести позиций укладывается в разумный размер (токены оцениваются как знаки / 2,8)", () => {
    const prompt = buildNormPickPrompt(batch);
    // Шесть позиций по ≤25 кандидатов: десяток тысяч знаков на пачку; десять позиций — вдвое меньше предела ручки.
    expect(prompt.length).toBeLessThan(60_000);
    expect(normPickMaxTokens(10)).toBe(1800);
  });

  it("схема запроса: длинное обрезается, а не отклоняется; лишнее сверх пределов — отказ", () => {
    const body = {
      regNumber: "0134300025826000377",
      subject: "П".repeat(2000),
      items: [{ id: "1", workName: "Демонтаж", quantity: 5, unit: "м2", remark: "п".repeat(900), section: "", candidates: [candidateBody()] }],
    };
    const parsed = normPickRequestSchema.parse(body);
    expect(parsed.subject.length).toBe(1000);
    expect(parsed.items[0]?.remark?.length).toBe(300);
    expect(parsed.items[0]?.section).toBeNull();

    expect(normPickRequestSchema.safeParse({ ...body, items: [] }).success).toBe(false);
    expect(normPickRequestSchema.safeParse({ ...body, items: Array.from({ length: 11 }, (_, i) => ({ ...body.items[0], id: String(i) })) }).success).toBe(false);
    expect(normPickRequestSchema.safeParse({ ...body, items: [{ ...body.items[0], candidates: [] }] }).success).toBe(false);
    expect(normPickRequestSchema.safeParse({ ...body, items: [{ ...body.items[0], candidates: Array.from({ length: 31 }, candidateBody) }] }).success).toBe(false);
  });
});

function candidateBody(): NormPickCandidate {
  return {
    key: "ГЭСН|15-01-070-01",
    book: "ГЭСН",
    code: "15-01-070-01",
    tableCode: "15-01-070",
    tableName: "Облицовка",
    rowName: "оконных проемов",
    unit: "м2",
    collection: "Отделочные работы",
    summary: "Установка верхних деталей окантовок",
  };
}

describe("группы таблицы с разным началом наименования", () => {
  it("строки 04–06 таблицы 63-03-007 («пластикового сайдинга») печатаются под своим заголовком, а не под заголовком металлических", () => {
    const rows = ["ГЭСНр|63-03-007-02", "ГЭСНр|63-03-007-04"].map((key) => {
      const found = INDEX.byKey.get(key);
      if (found === undefined) throw new Error(key);
      return found;
    });
    const candidates = collectNormCandidates(INDEX, { workName: "Демонтаж профлиста", units: ["м2"], section: null }).filter((candidate) =>
      rows.some((row) => row.code === candidate.code && row.baseType === candidate.book),
    );
    expect(candidates).toHaveLength(2);
    const prompt = buildNormPickPrompt({
      context: { regNumber: "1", subject: "s" },
      items: [{ id: "1", workName: "Демонтаж профлиста", quantity: 1, unit: "м2", remark: null, section: null, candidates }],
    });
    const metal = prompt.indexOf("из металлического сайдинга");
    const plastic = prompt.indexOf("из пластикового сайдинга");
    expect(metal).toBeGreaterThan(0);
    expect(plastic).toBeGreaterThan(metal);
    expect(prompt.indexOf("ГЭСНр|63-03-007-02")).toBeLessThan(plastic);
    expect(prompt.indexOf("ГЭСНр|63-03-007-04")).toBeGreaterThan(plastic);
  });
});

describe("правка ведомости человеком поверх выбора ИИ", () => {
  it("«норма» снимает пометку ИИ и коэффициенты на демонтаж, выбранные для нормы модели; остальные правки их сохраняют", () => {
    const picked = withAiDemolition(applyNormPick(bill({ id: "a-1" }), norm("ГЭСН|15-01-070-01"), { demolition: true, confidence: "high", reason: "откосы" }, null));
    const anchor = { itemId: "a-1", workName: picked.workName, quantity: picked.quantity, unit: picked.quantityUnit, positionNumber: null, normCode: picked.normCode, section: null };
    const sections = [{ title: "ВОР", items: [picked] }];

    const byHuman = applyBillEdits(sections, [{ kind: "norm", anchor, norm: { code: "26-01-066-01", baseType: "ГЭСН" } } satisfies BillEdit]);
    const item = byHuman.sections[0]?.items[0];
    expect(item).toMatchObject({ normCode: "26-01-066-01", normBaseType: "ГЭСН" });
    expect(item?.aiNormPick).toBeUndefined();
    expect(item?.customerConditions).toBeUndefined();
    expect(byHuman.manualNorm.has("a-1")).toBe(true);

    const quantityOnly = applyBillEdits(sections, [{ kind: "change", anchor, quantity: 99 } satisfies BillEdit]);
    expect(quantityOnly.sections[0]?.items[0]?.aiNormPick).toBeDefined();
    expect(quantityOnly.sections[0]?.items[0]?.customerConditions?.special?.id).toBe("M571-P83-T2-R4");
  });
});

describe("материалы: промпт и схема запроса", () => {
  const material: NormPickItem = {
    id: "2",
    workName: "Трубы стальные электросварные прямошовные, наружный диаметр 89 мм, толщина стенки 5 мм",
    quantity: 681.75,
    unit: "м",
    remark: null,
    section: "ВОР.xlsx",
    kind: "material",
    candidates: [],
    resources: [
      { key: "РЕСУРС|23.3.06.04-0104", code: "23.3.06.04-0104", name: "Трубы стальные электросварные, наружный диаметр 89 мм, толщина стенки 5 мм", unit: "м", price: 703.4 },
      { key: "РЕСУРС|23.3.06.04-0109", code: "23.3.06.04-0109", name: "Трубы стальные электросварные, наружный диаметр 108 мм, толщина стенки 4 мм", unit: "м", price: 801.9 },
    ],
  };
  const ambiguous: NormPickItem = { ...material, id: "3", workName: "Грунтовка стен", unit: "м2", kind: "ambiguous", candidates: [candidateBody()] };
  const work: NormPickItem = { id: "1", workName: "Демонтаж оконных откосов", quantity: 12, unit: "м2", remark: null, section: null, candidates: [candidateBody()] };
  const batch = { context: { regNumber: "0891200000626010037", subject: "Водопровод" }, items: [work, material, ambiguous] };

  it("промпт содержит правила для материалов: ресурс «РЕСУРС|шифр», норма для материала не принимается, характеристики, единицы", () => {
    const prompt = buildNormPickPrompt(batch);
    expect(prompt).toContain("## Материалы и оборудование (поставка)");
    expect(prompt).toContain("РЕСУРС|шифр");
    expect(prompt).toContain("Норму работы для материала выбирать нельзя");
    expect(prompt).toContain("Позиция без типа — работа");
    expect(prompt).toContain("подномер вида «11.1» под работой «11»");
    expect(prompt).toContain("«м» и «т» не переводятся друг в друга без массы метра");
    expect(prompt).toContain('"pick": "РЕСУРС|23.3.06.04-0026"');
  });

  it("материал печатается с типом и кандидатами-ресурсами; норм у него нет; работа без типа — как раньше", () => {
    const prompt = buildNormPickPrompt(batch);
    expect(prompt).toContain("### Позиция 1\nРабота: Демонтаж оконных откосов\nОбъём: 12 м2");
    const materialBlock = prompt.split("### Позиция ")[2] ?? "";
    expect(materialBlock).toContain("Тип: материал — поставка, не работа");
    expect(materialBlock).toContain("Наименование: Трубы стальные электросварные");
    expect(materialBlock).toContain("Кандидаты-ресурсы (шифр | наименование | единица | цена за единицу):");
    expect(materialBlock).toContain("РЕСУРС|23.3.06.04-0104 | Трубы стальные электросварные, наружный диаметр 89 мм, толщина стенки 5 мм | ед. м | цена 703,4 ₽");
    expect(materialBlock).not.toContain("Кандидаты (шифр");
  });

  it("неясная строка печатается с обоими списками", () => {
    const block = buildNormPickPrompt(batch).split("### Позиция ")[3] ?? "";
    expect(block).toContain("Тип: неясно — работа или материал");
    expect(block).toContain("Кандидаты (шифр | окончание наименования строки | единица нормы):");
    expect(block).toContain("Кандидаты-ресурсы");
  });

  it("схема запроса: материал без норм, но с ресурсами принимается; без норм и без ресурсов — отказ; ресурсов не больше двадцати", () => {
    const body = (patch: Record<string, unknown>) => ({
      regNumber: "1",
      subject: "s",
      items: [{ id: "1", workName: "Трубы", quantity: 5, unit: "м", remark: null, section: "", kind: "material", candidates: [], resources: material.resources, ...patch }],
    });
    expect(normPickRequestSchema.safeParse(body({})).success).toBe(true);
    expect(normPickRequestSchema.safeParse(body({ resources: [] })).success).toBe(false);
    expect(normPickRequestSchema.safeParse(body({ resources: undefined })).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, index) => ({ ...(material.resources?.[0] as object), code: `23.3.06.04-${String(index).padStart(4, "0")}`, key: `РЕСУРС|${String(index)}` }));
    expect(normPickRequestSchema.safeParse(body({ resources: many })).success).toBe(false);
    expect(normPickRequestSchema.safeParse(body({ kind: "other" })).success).toBe(false);
  });

  it("ответ модели «РЕСУРС|шифр» разбирается как обычный pick", () => {
    const parsed = parseNormPickResponse('{"items":[{"id":"2","pick":"РЕСУРС|23.3.06.04-0104","demolition":false,"confidence":"high","reason":"диаметр 89 мм"}]}');
    expect(parsed.picks[0]).toMatchObject({ id: "2", pick: "РЕСУРС|23.3.06.04-0104", confidence: "high" });
  });

  it("позиция, которой уже назначен материал, на подбор нормы не уходит", () => {
    expect(needsNormPick(bill())).toBe(true);
    expect(needsNormPick(bill({ materialRow: { reason: "x", pick: null, review: true, coverage: null, note: "n" } }))).toBe(false);
  });
});
