import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Вырезки из выгрузок Smeta.RU (закупки 32616439079, 32616445639, 32616406367, 0373100037626000119).
 *
 * Тексты — как их хранит база (`tender_documents.parsed_text`): первая строка «# имя файла», лист xlsx — CSV под меткой «=== лист ===».
 * От реальных файлов отличаются только размером: хвосты пустых ячеек справа свернуты до двенадцати запятых, лишние позиции убраны.
 *
 * - `rim-moscow-demolition` — ресурсно-индексная смета (Smeta.RU 12, ГЭСН/ФСБЦ, «на сентябрь 2026 года»): позиции 1, 3, 6, 8, 9, 15, 16, 17
 *   закупки 32616439079 — разборка по ГЭСНр, демонтаж по ГЭСН и ГЭСНм с поправкой «ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7», подстроки 999-9900 и «2 %», «Поправки к:» в
 *   наименовании, множители к НР и СП, ТЦ и ФСБЦ отдельными позициями. Итоги разделов, «ВСЕГО по смете» и НДС пересчитаны под вырезку
 *   (в оригинале 1 336 208,99 ₽ и 161 позиция); арифметика позиций — оригинальная;
 * - `rim-supply-subpositions` — лист сметы 32616445639 (Смета_9) целиком, шесть позиций, подстроки 2.1, 3.1, 3.2 (999-0005), 4.1 (ФСБЦ), 4.2, без разделов;
 * - `rim-sections-customer-price` — лист сметы 32616445639 (Смета_3) целиком, одиннадцать позиций, два раздела, ТЦ-подпозиция 4.1;
 * - `tsn-2001-moscow` — две сметы по ТСН-2001 Москвы (Форма № 4б, 11 граф) из архива закупки 32616406367: 02-01-01 и 09-01-01;
 * - `base-index-pdf` — начало и конец PDF-текста сметы «Составлен Базисно-индексным методом» закупки 0373100037626000119.
 */

const DIR = path.resolve(__dirname, "../domain/estimate/__fixtures__/smetaru");
const read = (name: string): string => readFileSync(path.join(DIR, name), "utf8");

export const RIM_DEMOLITION_TEXT = read("rim-moscow-demolition.txt");
export const RIM_SUPPLY_TEXT = read("rim-supply-subpositions.txt");
export const RIM_SECTIONS_TEXT = read("rim-sections-customer-price.txt");
export const TSN_2001_TEXT = read("tsn-2001-moscow.txt");
export const BASE_INDEX_PDF_TEXT = read("base-index-pdf.txt");

export const RIM_DEMOLITION_NAME = "Смета_текущий_ремонт_помещений_1-го_этажа.xlsx";
export const RIM_SUPPLY_NAME = "Смета_9.xlsx";
export const RIM_SECTIONS_NAME = "Смета_3.xlsx";
export const TSN_2001_NAME = "приложение к ТЗ_085-0016182.rar";
export const BASE_INDEX_PDF_NAME = "Локальный сметный расчет (Приложение № 1 к ООЗ ЭА № 25_44-ЭА-26).pdf";

/** Итоги вырезки `rim-moscow-demolition` («ВСЕГО по смете» без НДС, НДС 22 % и подразделы). */
export const RIM_DEMOLITION_TOTALS = { total: 63_235.86, vat: 13_911.89, firstSubsection: 29_532.67, secondSubsection: 33_703.19 } as const;
