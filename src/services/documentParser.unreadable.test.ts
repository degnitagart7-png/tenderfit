import { describe, expect, it } from "vitest";

import {
  isUnreadableText,
  PARSE_ERROR_PREFIX,
  UNSUPPORTED_FORMAT_TEXT,
} from "@/services/documentParser";

/**
 * Разбор документа не бросает исключение: он кладёт объяснение в поле текста.
 * Отличить объяснение от содержимого обязан вызывающий код — иначе смета
 * считается по строке «[Неподдерживаемый формат файла]» и выходит на ноль
 * рублей с видом настоящей.
 */
describe("isUnreadableText", () => {
  it("узнаёт неподдерживаемый формат", () => {
    expect(isUnreadableText(UNSUPPORTED_FORMAT_TEXT)).toBe(true);
  });

  it("узнаёт ошибку разбора вместе с её причиной", () => {
    expect(isUnreadableText(`${PARSE_ERROR_PREFIX}битый zip]`)).toBe(true);
  });

  it("не считает нечитаемым текст в квадратных скобках", () => {
    expect(isUnreadableText("[Раздел 1] Земляные работы, 120 м3")).toBe(false);
  });

  it("настоящий текст документа пропускает", () => {
    expect(isUnreadableText("ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ")).toBe(false);
  });
});
