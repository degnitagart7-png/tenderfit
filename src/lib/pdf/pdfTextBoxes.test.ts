import { describe, expect, it } from "vitest";
import {
  multiplyMatrix,
  readPdfTextBoxes,
  textItemToBox,
  type Matrix,
} from "@/lib/pdf/pdfTextBoxes";
import { buildTableGrid } from "@/lib/pdf/tableGrid";

/**
 * Матрица области просмотра страницы высотой 842 пункта (A4) без поворота.
 * Именно такую отдаёт `page.getViewport({ scale: 1 })`: третий элемент −1
 * переворачивает ось y, шестой переносит начало координат в левый верхний угол.
 */
const A4: Matrix = [1, 0, 0, -1, 0, 842];

function item(str: string, x: number, baselineY: number, size = 10, width = 50) {
  return { str, width, height: size, transform: [size, 0, 0, size, x, baselineY] };
}

describe("multiplyMatrix", () => {
  it("единичная матрица ничего не меняет", () => {
    const identity: Matrix = [1, 0, 0, 1, 0, 0];
    expect(multiplyMatrix(identity, [2, 0, 0, 3, 4, 5])).toEqual([2, 0, 0, 3, 4, 5]);
  });

  it("переворот оси y переносит точку в координаты чтения", () => {
    // Базовая линия на высоте 742 от низа страницы — это 100 от верха.
    expect(multiplyMatrix(A4, [10, 0, 0, 10, 20, 742])[5]).toBe(100);
  });
});

describe("textItemToBox", () => {
  it("переводит базовую линию снизу вверх в верхний край сверху вниз", () => {
    /*
      Без этого перевода строки страницы выстроятся снизу вверх, и таблица
      окажется перевёрнутой — причём выглядеть это будет как правильная
      таблица с неправильным порядком строк, то есть ошибка не бросится
      в глаза.
    */
    const box = textItemToBox(item("1 339,47", 20, 742, 10), A4);

    expect(box?.x).toBe(20);
    expect(box?.height).toBe(10);
    // 842 − 742 = 100 — базовая линия; верх строки на высоту шрифта выше.
    expect(box?.y).toBe(90);
  });

  it("строка ниже на странице получает больший y", () => {
    const upper = textItemToBox(item("шапка", 20, 742), A4);
    const lower = textItemToBox(item("строка", 20, 700), A4);

    expect(lower?.y ?? 0).toBeGreaterThan(upper?.y ?? 0);
  });

  it("ширина берётся как есть: pdfjs уже учёл кегль", () => {
    /*
      Домножение ширины на масштаб матрицы было бы правдоподобной ошибкой:
      для кегля 10 рамки раздуваются десятикратно, смыкаются, пустых полос
      между колонками не остаётся — и страница схлопывается в одну колонку.
      Выглядит это как «таблица не распозналась», а причина совсем не там,
      где её будут искать. Поймано сквозным прогоном, см. тест ниже.
    */
    const box = textItemToBox(item("код", 20, 742, 20, 30), A4);

    expect(box?.width).toBe(30);
    // Высота при этом берётся из матрицы и кегль учитывает.
    expect(box?.height).toBe(20);
  });

  it("повёрнутый текст пропускается, а не вписывается кривой рамкой", () => {
    // Вертикальная подпись колонки: рамка не выровнена по осям, и вписать её
    // в сетку прямоугольников нельзя, не соврав о её месте.
    const rotated = {
      str: "наименование",
      width: 50,
      height: 10,
      transform: [0, 10, -10, 0, 20, 742],
    };

    expect(textItemToBox(rotated, A4)).toBeNull();
  });

  it("битая матрица не роняет разбор", () => {
    expect(textItemToBox({ str: "x", width: 1, height: 1, transform: [1, 0] }, A4)).toBeNull();
  });
});

/**
 * Собирает минимальный корректный PDF с текстовым слоем.
 *
 * Нужен именно настоящий файл, а не поддельные элементы: договор между pdfjs и
 * этим модулем — про единицы измерения, и проверить его можно только на
 * документе, который pdfjs действительно разобрал. Ровно так была найдена
 * ошибка с домножением ширины: все юнит-тесты при ней проходили, потому что
 * закрепляли то же неверное допущение, из которого написан код.
 */
function makePdf(words: readonly { text: string; x: number; y: number }[]): Uint8Array {
  const nl = "\n";
  const content = words
    .map((word) => `BT /F1 10 Tf ${word.x} ${word.y} Td (${word.text}) Tj ET`)
    .join(nl);

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>${nl}stream${nl}${content}${nl}endstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = `%PDF-1.4${nl}`;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj${nl}${body}${nl}endobj${nl}`;
  });

  const xref = pdf.length;
  pdf += `xref${nl}0 ${objects.length + 1}${nl}0000000000 65535 f ${nl}`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n ${nl}`;
  }
  pdf += `trailer${nl}<</Size ${objects.length + 1}/Root 1 0 R>>${nl}startxref${nl}${xref}${nl}%%EOF`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

describe("readPdfTextBoxes: сквозной разбор настоящего PDF", () => {
  const TABLE = makePdf([
    { text: "Kod", x: 20, y: 700 },
    { text: "Naimenovanie", x: 120, y: 700 },
    { text: "Cena", x: 400, y: 700 },
    { text: "91.01.01-035", x: 20, y: 670 },
    { text: "Buldozer", x: 120, y: 670 },
    { text: "1339,47", x: 400, y: 670 },
    { text: "91.01.05-128", x: 20, y: 640 },
    { text: "Draglajn", x: 120, y: 640 },
    { text: "88134,75", x: 400, y: 640 },
  ]);

  it("находит текстовый слой и все слова страницы", async () => {
    const result = await readPdfTextBoxes(TABLE);

    expect(result.hasTextLayer).toBe(true);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.boxes).toHaveLength(9);
    expect(result.pages[0]?.rotatedSkipped).toBe(0);
  });

  it("разбирает страницу в таблицу: три колонки, строки в порядке чтения", async () => {
    const result = await readPdfTextBoxes(TABLE);
    const grid = buildTableGrid(result.pages[0]?.boxes ?? []);

    expect(grid.columns).toHaveLength(3);
    expect(grid.rows).toEqual([
      ["Kod", "Naimenovanie", "Cena"],
      ["91.01.01-035", "Buldozer", "1339,47"],
      ["91.01.05-128", "Draglajn", "88134,75"],
    ]);
  });

  it("документ без текстового слоя опознаётся как скан", async () => {
    const result = await readPdfTextBoxes(makePdf([]));

    expect(result.hasTextLayer).toBe(false);
  });
});
