-- 20261005000015_add_tender_doc_terms.sql
-- Обеспечение заявки, обеспечение контракта и аванс, найденные в тексте
-- документации (src/domain/documentTerms.ts).
--
-- Отдельная колонка, а не security_bid / security_contract / advance_payment:
-- те перезаписывает каждый прогон синхронизации, и найденное в документах
-- затиралось бы пустым значением площадки. doc_terms синхронизация не трогает;
-- реквизиты площадки при показе остаются главнее (applyDocumentTerms).
--
-- Формат: { "bidSecurity"?: Term, "contractSecurity"?: Term, "advance"?: Term },
-- Term = { required, percent, amount, quote, strong }.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Пока миграция не применена, запись условий молча пропускается, лента
-- работает как раньше. После применения заполнить по уже скачанной
-- документации: npm run backfill:doc-terms

alter table public.tenders
  add column if not exists doc_terms jsonb;
