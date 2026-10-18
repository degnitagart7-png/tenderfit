import { describe, expect, it } from "vitest";

import {
  applyNormMaterial,
  checkNormMaterialPick,
  collectNormMaterialMatches,
  isOpenNormMaterial,
  openNormMaterials,
  pickNormMaterialByName,
  stripAiNormMaterials,
  substituteNormMaterial,
} from "@/domain/estimate/normMaterial";
import { BY_PROJECT_RESOURCE, PPU, PPU_NORM, PPU_RESOURCE, ppuBook, ppuResources, roofItem, SERVICE_RESOURCE } from "@/domain/estimate/normMaterial.fixtures";
import { createResourceIndex } from "@/domain/estimate/resourceCandidates";

const index = createResourceIndex(ppuBook());
const search = (over: Partial<Parameters<typeof collectNormMaterialMatches>[1]> = {}) =>
  collectNormMaterialMatches(index, {
    resourceCode: PPU_RESOURCE.code,
    resourceName: PPU_RESOURCE.name,
    unit: "кг",
    workName: "Изоляция кровли напыляемым пенополиуретаном толщиной 50 мм",
    normName: PPU_NORM.fullName,
    ...over,
  });

describe("ресурсы нормы, которым подбирается материал", () => {
  it("без марки, с числовым расходом и единицей; «П» и служебный ресурс — нет", () => {
    expect(isOpenNormMaterial(PPU_RESOURCE)).toBe(true);
    expect(isOpenNormMaterial(BY_PROJECT_RESOURCE)).toBe(false);
    expect(isOpenNormMaterial(SERVICE_RESOURCE)).toBe(false);
    expect(isOpenNormMaterial({ ...PPU_RESOURCE, projectSpecific: false })).toBe(false);
    expect(isOpenNormMaterial({ ...PPU_RESOURCE, unit: " " })).toBe(false);
    expect(isOpenNormMaterial({ ...PPU_RESOURCE, kind: "MACHINE" })).toBe(false);
  });

  it("материал, названный человеком, ресурс закрывает", () => {
    expect(openNormMaterials(PPU_NORM, {}).map((resource) => resource.code)).toEqual(["14.2.05.03"]);
    expect(openNormMaterials(PPU_NORM, { projectMaterials: [{ code: "14.2.05.03", name: "Свой", unit: "кг", quantity: 1, unitPrice: 1 }] })).toEqual([]);
  });
});

describe("кандидаты", () => {
  it("группа кода идёт первой; единица кандидата обязана переводиться из единицы ресурса нормы", () => {
    const { matches } = search();
    const codes = matches.map((match) => match.entry.code);
    expect(codes.slice(0, 3).sort()).toEqual([PPU.truth, PPU.epoxy, PPU.perTonne].sort());
    expect(codes).not.toContain(PPU.panel);
    // Группа: первым — запись, ближайшая к описанию работы, а не по коду.
    expect(codes[0]).toBe(PPU.truth);
  });

  it("код ресурса — не группа: кандидаты только по словам названия ресурса, работы и нормы", () => {
    const { matches } = search({ resourceCode: "999-9901", resourceName: "Утеплитель", workName: "Напыление пенополиуретана, состав на основе полиуретановых смол" });
    const codes = matches.map((match) => match.entry.code);
    expect(codes).toContain(PPU.truth);
    expect(codes).not.toContain(PPU.panel);
    expect(codes).not.toContain(PPU.bolts);
  });

  it("записи группы без общих слов с работой — тоже кандидаты; все из группы, не больше пятнадцати", () => {
    const many = Array.from({ length: 40 }, (_, position) => ({
      code: `14.2.05.03-${String(100 + position)}`,
      name: `Материал ${String(position)} цветной`,
      unit: "кг",
      price: 10 + position,
      machinistSalary: null,
      machinistHours: null,
      source: "CURRENT_ZONE" as const,
      period: null,
      zone: null,
    }));
    const big = createResourceIndex(ppuBook([...ppuResources(), ...many]));
    const { matches } = collectNormMaterialMatches(big, { resourceCode: "14.2.05.03", resourceName: PPU_RESOURCE.name, unit: "кг", workName: "Напыление", normName: PPU_NORM.fullName });
    expect(matches.length).toBe(15);
    expect(matches.every((match) => match.entry.code.startsWith("14.2.05.03-"))).toBe(true);
  });

  it("единица ресурса нормы без перевода в единицы справочника — кандидатов нет", () => {
    expect(search({ unit: "руб." }).matches).toEqual([]);
    expect(search({ unit: "м3" }).matches).toEqual([]);
  });
});

describe("запасной выбор без модели", () => {
  it("единственный кандидат с высоким покрытием слов названия ресурса нормы", () => {
    const only = createResourceIndex(ppuBook(ppuResources({ perTonne: false })));
    const found = collectNormMaterialMatches(only, { resourceCode: PPU_RESOURCE.code, resourceName: PPU_RESOURCE.name, unit: "кг", workName: "Напыление", normName: PPU_NORM.fullName });
    expect(pickNormMaterialByName(PPU_RESOURCE.name, found.byResourceName)?.entry.code).toBe(PPU.truth);
  });

  it("двойник с теми же словами — неоднозначно; название из одного слова — не берётся", () => {
    const { byResourceName } = search();
    expect(pickNormMaterialByName(PPU_RESOURCE.name, byResourceName)).toBeNull();
    expect(pickNormMaterialByName("Состав", byResourceName)).toBeNull();
    expect(pickNormMaterialByName("", [])).toBeNull();
  });
});

describe("проверка ответа", () => {
  const candidates = search().matches.map((match) => ({ key: `РЕСУРС|${match.entry.code}` }));

  it("принимается ресурс из списка с переводимой единицей", () => {
    expect(checkNormMaterialPick(`РЕСУРС|${PPU.truth}`, candidates, index, "кг")).toMatchObject({ status: "ACCEPTED" });
    expect(checkNormMaterialPick(`РЕСУРС|${PPU.perTonne}`, candidates, index, "кг")).toMatchObject({ status: "ACCEPTED" });
  });

  it("отклоняется: вне списка, нет в справочнике, единица не переводится, норма вместо ресурса", () => {
    expect(checkNormMaterialPick(`РЕСУРС|${PPU.panel}`, candidates, index, "кг")).toMatchObject({ status: "REJECTED" });
    expect(checkNormMaterialPick("РЕСУРС|нет", [{ key: "РЕСУРС|нет" }], index, "кг")).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("нет в справочнике") });
    expect(checkNormMaterialPick(`РЕСУРС|${PPU.truth}`, candidates, index, "м2")).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("не переводится") });
    expect(checkNormMaterialPick("ГЭСН|26-01-021-01", [{ key: "ГЭСН|26-01-021-01" }], index, "кг")).toMatchObject({ status: "REJECTED" });
  });
});

describe("запись в позицию и подстановка в расчёте", () => {
  const entry = index.byCode.get(PPU.truth);
  if (entry === undefined) throw new Error("нет ресурса");

  it("запись помнит норму и ресурс; повторная запись того же ресурса заменяет прежнюю", () => {
    const first = applyNormMaterial(roofItem(), PPU_NORM, PPU_RESOURCE, entry, { source: "AI", reason: "смола для напыления.", confidence: "high", coverage: null });
    expect(first.aiNormMaterials).toHaveLength(1);
    expect(first.aiNormMaterials?.[0]).toMatchObject({ normCode: PPU_NORM.code, normBaseType: "ГЭСН", normResourceCode: "14.2.05.03", code: PPU.truth, review: false });
    expect(first.aiNormMaterials?.[0]?.note).toContain("материал подобран ИИ: смола для напыления;");
    const second = applyNormMaterial(first, PPU_NORM, PPU_RESOURCE, entry, { source: "NAME", reason: "", confidence: null, coverage: 1 });
    expect(second.aiNormMaterials).toHaveLength(1);
    expect(second.aiNormMaterials?.[0]).toMatchObject({ pick: "NAME", review: true });
    expect(second.aiNormMaterials?.[0]?.note).toContain("проверьте: материал выбран кодом, без модели");
  });

  it("подстановка: ресурс переписан под материал (код, единица, расход); без записи, при другой норме или человеческом материале — null", () => {
    const item = applyNormMaterial(roofItem(), PPU_NORM, PPU_RESOURCE, entry, { source: "AI", reason: "ок", confidence: "high", coverage: null });
    const substituted = substituteNormMaterial(item, PPU_NORM, PPU_RESOURCE);
    expect(substituted?.resource).toMatchObject({ code: PPU.truth, unit: "кг", quantity: 165, projectSpecific: false, kind: "MATERIAL" });
    expect(substituteNormMaterial(roofItem(), PPU_NORM, PPU_RESOURCE)).toBeNull();
    expect(substituteNormMaterial(item, { code: "26-01-021-02", baseType: "ГЭСН" }, PPU_RESOURCE)).toBeNull();
    expect(substituteNormMaterial(item, { code: PPU_NORM.code, baseType: "ГЭСНм" }, PPU_RESOURCE)).toBeNull();
    expect(substituteNormMaterial({ ...item, projectMaterials: [{ code: "14.2.05.03", name: "Свой", unit: "кг", quantity: 1, unitPrice: 1 }] }, PPU_NORM, PPU_RESOURCE)).toBeNull();
    // Норма уже называет марку (ресурс не «по проекту») — подстановка не нужна.
    expect(substituteNormMaterial(item, PPU_NORM, { ...PPU_RESOURCE, projectSpecific: false })).toBeNull();
  });

  it("выбор человеком нормы снимает подобранные материалы", () => {
    const item = applyNormMaterial(roofItem(), PPU_NORM, PPU_RESOURCE, entry, { source: "AI", reason: "ок", confidence: "high", coverage: null });
    expect(stripAiNormMaterials(item).aiNormMaterials).toBeUndefined();
    const plain = roofItem();
    expect(stripAiNormMaterials(plain)).toBe(plain);
  });
});
