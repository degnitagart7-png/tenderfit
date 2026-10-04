import type { Tender } from "@/domain/entities";

/**
 * Сборка текста закупки для сопоставления с профилем компании.
 * Вынесено из scoring/index.ts, чтобы проверки допуска
 * (scoring/admission.ts) и скоринг использовали один и тот же текст
 * и не тянули друг друга по кругу импортов.
 */
export function buildTenderText(tender: Tender): string {
  const parts = [tender.subject, tender.deliveryAddress];
  for (const lot of tender.lots) {
    parts.push(lot.subject);
  }
  for (const doc of tender.documents) {
    parts.push(doc.title, doc.text);
  }
  for (const req of tender.requirements) {
    parts.push(req.title, req.description);
  }
  return parts.join("\n");
}

/**
 * Текст предмета договора: наименование закупки и предметы лотов.
 * В отличие от buildTenderText сюда не попадают документация и требования —
 * по ним нельзя понять, какой именно вид работ заказывается.
 */
export function buildSubjectText(tender: Tender): string {
  const parts = [tender.subject];
  for (const lot of tender.lots) {
    parts.push(lot.subject);
  }
  return parts.join("\n");
}
