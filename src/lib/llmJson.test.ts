import { describe, expect, it } from "vitest";

import { extractLlmJson } from "@/lib/llmJson";

describe("extractLlmJson", () => {
  it("голый JSON и JSON в ограждении", () => {
    expect(extractLlmJson('{"rows":[]}')).toBe('{"rows":[]}');
    expect(extractLlmJson('```json\n{"rows":[1]}\n```')).toBe('{"rows":[1]}');
  });

  it("пояснение Claude после ограждения отбрасывается", () => {
    const raw = '```json\n{"has_bill": false, "rows": []}\n```\nВ документе «ПРОТОКОЛ НМЦК.pdf» нет ведомости объёмов работ. Есть {скобки} в тексте.';
    expect(JSON.parse(extractLlmJson(raw))).toEqual({ has_bill: false, rows: [] });
  });

  it("текст до JSON, скобки и кавычки внутри строк", () => {
    const raw = 'Ответ: {"name": "Демонтаж \\"профлиста\\" {м2}", "items": [{"a": "]"}]} — готово';
    expect(JSON.parse(extractLlmJson(raw))).toEqual({ name: 'Демонтаж "профлиста" {м2}', items: [{ a: "]" }] });
  });

  it("массив верхнего уровня", () => {
    expect(JSON.parse(extractLlmJson('Вот: [{"id":"1"}] конец'))).toEqual([{ id: "1" }]);
  });

  it("оборванный ответ — хвост от первой скобки для спасения строк", () => {
    expect(extractLlmJson('```json\n{"rows":[{"a":1},{"a":')).toBe('{"rows":[{"a":1},{"a":');
  });
});
