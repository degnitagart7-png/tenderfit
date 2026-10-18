import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Вырезки из документации закупки 0302300048726001118 (Улан-Удэ, ремонтные работы, шесть ЛСР заказчика).
 *
 * Тексты — как их хранит база (`tender_documents.parsed_text`): архив — это файлы подряд под метками
 * «=== имя ===», лист xlsx — CSV. Из ячеек оставлены первые 16: хвосты пустых ячеек и повторы подписей
 * справа в репозиторий не нужны, а строка нумерации граф и все 12 граф остаются.
 *
 * - три ЛСР целиком: 02-02-05-13 (электропривод, ТЦ-оборудование), 02-02-12 (желоб, исключения материалов
 *   отрицательным объёмом), 02-02-08 (вентиляция, оборудование по ТЦ, поставки ФСБЦ, пусконаладка);
 * - «Смета контракта» по приказу 841/пр: два приложения из проекта контракта (таблица Word, табуляция) и лист
 *   «Проект сметы контракта» из обоснования НМЦК (CSV, с ценами).
 */

const DIR = path.resolve(__dirname, "../domain/estimate/__fixtures__/t1118");
const read = (name: string): string => readFileSync(path.join(DIR, name), "utf8");

export const LSR_05_13_TEXT = read("lsr-02-02-05-13.txt");
export const LSR_12_TEXT = read("lsr-02-02-12.txt");
export const LSR_08_TEXT = read("lsr-02-02-08.txt");
export const CONTRACT_ESTIMATE_TEXT = read("contract-estimate.txt");
export const NMCK_CONTRACT_ESTIMATE_12_TEXT = read("nmck-contract-estimate-12.txt");
/** Из «Обоснования НМЦК»: обоснование иным методом (лимит, «цена по ЛСР»), шесть листов «ССР Расчёт НМЦК» (приложения 1.1-1.6) и шесть проектов смет контракта (3.1-3.6); ячейки — первые 11. */
export const NMCK_CALCULATION_TEXT = read("nmck-calculation.txt");

export const DESCRIPTION_NAME = "Описание объекта закупки.rar.zip";
export const NMCK_NAME = "Обоснование НМЦК.rar.zip";
export const CONTRACT_NAME = "Проект Муниципального контракта.doc.zip";

/** Итоги «ВСЕГО по смете» с НДС 22 % — как в ЛСР заказчика. */
export const TOTALS_WITH_VAT = { "02-02-05/13": 39_064.75, "02-02-08": 1_135_429.59, "02-02-12": 52_622.66 } as const;
/** То же без НДС: сумма «Всего по позиции» по позициям и подпозициям. */
export const TOTALS_EX_VAT = { "02-02-05/13": 32_020.29, "02-02-08": 930_679.99, "02-02-12": 43_133.33 } as const;

function archive(name: string, entries: readonly { readonly file: string; readonly text: string }[]): string {
  return [`=== ${name} ===`, ...entries.map((entry) => `=== ${entry.file} ===\n${entry.text}`)].join("\n");
}

/** «Описание объекта закупки»: три ЛСР, как они лежат в архиве заказчика. */
export const DESCRIPTION_TEXT = archive("Описание объекта закупки.rar", [
  { file: "Описание объекта закупки/ЛСР 02-02-05-13. Рем раб по электроприводу клапана дымоудаления 24.09.2026.xlsx", text: LSR_05_13_TEXT },
  { file: "Описание объекта закупки/ЛСР 02-02-08 Ремонтные работы по вентиляции.24.09.2026.xlsx", text: LSR_08_TEXT },
  { file: "Описание объекта закупки/ЛСР 02-02-12. Ремонт водосточного желоба 24.09.2026.xlsx", text: LSR_12_TEXT },
]);

/** «Обоснование НМЦК»: те же ЛСР повторно и «Проект сметы контракта» с ценами. */
export const NMCK_TEXT = archive("Обоснование НМЦК.rar", [
  { file: "Обоснование НМЦК/Приложение №2.2 ЛСР к НМЦК.xlsx", text: LSR_08_TEXT },
  { file: "Обоснование НМЦК/Приложение №2.5 ЛСР к НМЦК.xlsx", text: LSR_12_TEXT },
  { file: "Обоснование НМЦК/Приложение №2.6 ЛСР к НМЦК.xlsx", text: LSR_05_13_TEXT },
  { file: "Обоснование НМЦК/Приложение №3.5 Проект сметы контракта.xlsx", text: NMCK_CONTRACT_ESTIMATE_12_TEXT },
]);

/** Проект контракта: условия и два приложения «Смета контракта» (укрупнённые позиции «ЛС … Поз.:»). */
export const CONTRACT_TEXT = [
  "Муниципальный контракт № _______",
  "3.6. Муниципальный заказчик производит оплату работ по форме сметы контракта, согласно Приказа Минстроя России от 23.12.2019 №841/пр.",
  "",
  CONTRACT_ESTIMATE_TEXT,
].join("\n");

export const DOCUMENTS_1118 = [
  { name: NMCK_NAME, text: NMCK_TEXT },
  { name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT },
  { name: CONTRACT_NAME, text: CONTRACT_TEXT },
] as const;
