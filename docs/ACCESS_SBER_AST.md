# Доступ к Сбербанк-АСТ: коммерческие торги

Статус: **проверено на живом API 21.09.2026** — реестр закупок и карточки отдаются обычным POST-запросом без авторизации, капчи и КЭП. Рабочий код: `src/adapters/tender-source/sberAstTenderSourceAdapter.ts` + `src/adapters/tender-source/sberAstParser.ts`, фикстуры из реального ответа: `src/adapters/tender-source/sberAstTestFixtures.ts`.

КЭП нужна только для подачи заявки. Вход через браузер в `utp.sberbank-ast.ru` для чтения реестра не требуется, поэтому «обходить вход каждый раз» не нужно — данные берутся напрямую.

## Поиск

```
POST https://www.sberbank-ast.ru/api/Processing/main
Content-Type: application/json

{
  "windowCode": "/EsOpenUnitedPurchaseList",
  "actionType": "MONITOR",
  "actionCode": "default",
  "filterBody": "<query>…</query>",
  "parm": "es"
}
```

Тело `filterBody` — XML-фильтр:

```xml
<query>
  <targetPageCode>OTUnitedPurchaseList</targetPageCode>
  <searchbyorg>1</searchbyorg>
  <sourceTerm>Торги коммерческих заказчиков</sourceTerm>
  <searchBarType>anyWord</searchBarType>
  <mainInput>ноутбук</mainInput>
  <pagenum>0</pagenum>
  <pagesize>100</pagesize>
  <publicDate>
    <startPublicDate>23.06.2026</startPublicDate>
    <endPublicDate>21.09.2026 23:59:59</endPublicDate>
  </publicDate>
</query>
```

`sourceTerm` выбирает секцию площадки; «Торги коммерческих заказчиков» — это группа VIP (коммерческие закупки вне 44-ФЗ/223-ФЗ). `pagenum` начинается с 0, `pagesize` проверен до 100, сортировка — по дате публикации, убывание. Страницы не пересекаются.

## Формат ответа

Прямой HTTP-запрос возвращает JSON в стиле Elasticsearch:

```
{ took, timed_out, _shards, PurchState,
  PurchaseList: [ { _id, _source, highlight, sort } ],
  Aggregation, Total }
```

В браузере площадка дополнительно оборачивает его в `{ "data": "<строка JSON>" }` — `parseSberSearchPayload` умеет разворачивать обе формы.

## Поля `_source`

| Данные | Поле |
| --- | --- |
| Код закупки | `PurchaseCodeNoBidTerm` (например `SBR028-2609210061`) |
| Код лота | `purchCode` = код закупки + `.N` (`SBR028-2609210061.4`) |
| Номер лота | `BidNo` |
| Внутренний ID | `PurchaseId` |
| Предмет | `purchName`, для лота — `BidName` / `products` |
| Заказчик | `CustomerNickName` → `OrgName` → `CustomerFullName` |
| ИНН заказчика | `CustomerInn` → `OrgInn` |
| Сумма лота | `purchAmountRUB` → `purchAmount` (строка, часто `null`) |
| Валюта | `purchCurrency` |
| Регион | `RegionName` |
| Адрес/контакты | `orgContacts` |
| Даты | `PublicDate`, `RequestDate`, `RequestAcceptDate`, `EndDate`, `LastActionDt`, `purchUpdateAt`, `lastChange` |
| Способ закупки | `PurchaseTypeName` |
| Этап и состояние | `PurchaseStageTerm`, `purchStateName` |
| Архив | `IsInArchive` (`"1"` = архив) |
| Только СМП | `IsSMPTerm` («Да»/«Нет») |
| Нацрежим | `NationalRegimeType` |
| Ссылка на карточку | `objectHrefTerm` |

Даты приходят в формате «дд.мм.гггг чч:мм» **по Москве** — парсер переводит их в UTC со смещением +3 ч (`SBER_TZ_OFFSET_HOURS`).

Кодов ОКПД2 в поисковой выдаче нет — они есть только в карточке закупки.

## Лоты → одна карточка

Выдача отдаёт **отдельную запись на каждый лот**, поэтому без склейки одна закупка попадает в ленту несколькими строками (проверено: `SBR028-2609210061.1`–`.4` — четыре одинаковых «Закупка ноутбуков»).

Правила склейки (`mergeSberTenders`, `mergeSberPurchases`):

- `regNumber` = код закупки без номера лота;
- цена закупки = сумма цен лотов;
- срок подачи заявок = самый ранний среди лотов;
- дата последнего обновления = самая поздняя;
- все лоты сохраняются в `lots[]`, отсортированные по номеру;
- повторы одного и того же лота на разных страницах отбрасываются по `sberBidKey`.

## Гигиена ленты

Поиск площадки смешивает актуальные и мусорные записи. `isSberPurchaseActive` оставляет только те, где реально можно подать заявку:

- отбрасываются архивные (`IsInArchive = "1"`);
- отбрасывается «Процедура обоснования НМЦ» — это сбор цен, а не закупка;
- отбрасываются состояния «Завершен(-а)», «Отменен(-а)», «Не состоялся», «Прекращен», этапы «Завершено»/«Отменено»;
- требуется этап «Подача заявок» либо состояние «Прием заявок»/«В процессе»;
- срок подачи (`RequestDate`, иначе `RequestAcceptDate`) должен быть в будущем.

Цена `0` означает «не указана» (часто у запросов предложений и цен) — такие закупки **не** отсеиваются ценовым фильтром профиля.

## Надёжность и ограничения

- Rate limit: в адаптере throttle, по умолчанию 2 запроса/сек; повторы с экспоненциальной задержкой при HTTP-сбое или ответе, не похожем на JSON.
- **Площадка, как и ЕИС, блокирует зарубежные IP** — с Vercel запросы не проходят. Поэтому синхронизация выполняется `scripts/sync-eis.ts` на машине с российским адресом, а продакшен читает готовую ленту из Supabase. Сейчас это домашний ПК по расписанию Windows Task Scheduler (каждые 2 ч); после переезда — `scripts/worker.ts` на арендованном сервере, порядок установки и обслуживания в docs/REFERENCE_RU_WORKER.md.
- В базе закупки площадки хранятся как `law = 'COMMERCIAL'`, `data_source = 'SBER_AST'` (миграция `supabase/migrations/20260921000002_add_sber_ast_source.sql`). Колонка `eis_url` используется как общая ссылка на первоисточник.
- Документы закупки лежат в карточке `PurchaseView`; отдельный парсер страницы не реализован — `fetchDocuments` возвращает ссылку на карточку.
- Формат ответа и названия полей могут измениться без предупреждения.

## Sandbox-особенность (только локальная отладка)

Как и с ЕИС: в окружении с MITM-прокси Node fetch падает с `SELF_SIGNED_CERT_IN_CHAIN`. В `.env.local` для локальных запусков стоит `NODE_TLS_REJECT_UNAUTHORIZED=0`; в коде адаптера отключение проверки сертификата не используется и не должно использоваться в продакшене.
