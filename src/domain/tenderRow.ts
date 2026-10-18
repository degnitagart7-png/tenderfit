import type { Tender } from "@/domain/entities";

/**
 * Строка таблицы `tenders` из доменной закупки — общие колонки.
 *
 * Одна сборка на всех, кто пишет закупку в базу: плановый и живой прогон
 * (`scripts/sync-eis.ts`, к строке он добавляет свои пометки в `raw_data`) и
 * добавление закупки по ссылке (`src/services/tenderLinkImport.ts`). Копия
 * разошлась бы молча: новая колонка появилась бы в ленте у одних закупок и
 * пропала у других.
 */
export function tenderBaseRow(t: Tender) {
  return {
    reg_number: t.regNumber,
    external_id: t.externalId,
    law: t.law,
    placing_way: t.placingWay,
    subject: t.subject,
    customer_name: t.customerName,
    customer_inn: t.customerInn,
    region: t.region,
    delivery_address: t.deliveryAddress || null,
    price: t.financial.price || null,
    currency: t.financial.currency || "RUB",
    advance_payment: t.financial.advancePercent || null,
    security_bid: t.financial.bidSecurityAmount || null,
    security_contract: t.financial.contractSecurityAmount || null,
    submission_end: t.deadlines.submissionEnd,
    publication_date: t.deadlines.publicationDate || null,
    last_update_date: t.deadlines.lastUpdateDate || null,
    delivery_term_days: t.deadlines.deliveryTermDays || null,
    okpd2_codes: t.okpd2Codes.length > 0 ? t.okpd2Codes : null,
    lots: t.lots.length > 0 ? t.lots : null,
    requirements: t.requirements.length > 0 ? t.requirements : null,
    national_regime: t.nationalRegime,
    only_for_smp: t.onlyForSmp,
    // Общая колонка для ссылки на первоисточник: карточка закупки на той
    // площадке, которая её отдала.
    eis_url: t.eisUrl || null,
    data_source: t.dataSource,
  };
}
