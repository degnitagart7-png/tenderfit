/**
 * Фикстуры SOAP-экспорта ТЭК-Торга.
 *
 * Всё, что здесь лежит, получено из настоящих ответов `https://api.tektorg.ru/procedures/soap`
 * (запросы только на чтение, 01.10.2026 и окно обновлений 20–22.09.2026, секция `zakupki`).
 * Структура сверена с живой WSDL `https://api.tektorg.ru/procedures/wsdl`: имена элементов,
 * атрибут `id` у `<procedure>` и `<lot>`, блок `<documents><document>`, адрес организатора
 * в `<legal>` и `<postal>`, заказчики внутри лота.
 *
 * Две правки относительно байт-в-байт копии, обе помечены ниже по тексту:
 *
 * 1. Счётчики страниц в шапке приведены к трём процедурам фикстуры — настоящие
 *    `totalProcedures` и `totalPage` описывали бы выдачу, которой здесь нет.
 * 2. Имя, телефон и почта контактного лица заменены на вымышленные. Площадка
 *    публикует их открыто, но тащить чужие персональные данные в репозиторий
 *    незачем, а на разбор подстановка не влияет: парсер эти поля не читает.
 *
 * Всё остальное — дословно ответ площадки, включая CDATA в `<fullName>`, пустые
 * самоуплотнённые теги вроде `<region/>` и лоты, идущие в обратном порядке.
 */

/**
 * Три процедуры в одной странице ответа.
 *
 * Первая (`ЗП6082206`) — с номером ЕИС, значит 223-ФЗ, и с двумя лотами, причём
 * лот №2 площадка отдала раньше лота №1: порядок элементов в ответе не совпадает
 * с нумерацией, и наивный «первый лот = первый по счёту» здесь ломается.
 *
 * Вторая (`ЗП610102`) — чисто коммерческая: `eisRegistryNumber` отсутствует вовсе,
 * а у лота нет `startPrice` (это запрос ценовой информации, цены не существует).
 * Регион организатора пуст, весь адрес уехал в `<house>` — так площадка отдаёт
 * примерно семь записей из десяти.
 *
 * Третья (`ЗП6091269`) — регион организатора заполнен, а в названии организации
 * CDATA с кавычками внутри. Заполненный регион вообще редкость: из ста процедур
 * окна обновлений он есть у тридцати, причём семнадцать из них вместо короткого
 * названия несут форму из ФИАС — «Город Москва столица Российской Федерации город
 * федерального значения». Сопоставлять такие названия со списком регионов профиля
 * придётся отдельно; там, где региона нет, весь адрес лежит в `<house>`.
 */
export const TEKTORG_LIVE_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:ns1="http://tektorg.loc/api" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <SOAP-ENV:Body>
    <SOAP-ENV:proceduresResponse>
      <totalProcedures>3</totalProcedures>
      <currentPage>1</currentPage>
      <totalPage>1</totalPage>
      <limitProceduresInPage>100</limitProceduresInPage>
      <sectionName>223-ФЗ и Коммерческие закупки</sectionName>
      <sectionCode>zakupki</sectionCode>
      <procedures>
        <procedure id="228142">
                  <remoteId>228142</remoteId>
                  <url_to_showcase>https://www.tektorg.ru/223-fz/procedures/19786237</url_to_showcase>
                  <registryNumber>ЗП6082206</registryNumber>
                  <eisRegistryNumber>32616329240</eisRegistryNumber>
                  <title>Поставка электро-бензоинструмента (лот 1, лот 2) АО «Регионгаз-инвест»</title>
                  <datePublished>2026-08-27T14:54:11+03:00</datePublished>
                  <dateUpdated>2026-09-21T07:31:02+03:00</dateUpdated>
                  <dateEndRegistration>2026-09-04T13:00:00+03:00</dateEndRegistration>
                  <dateEndSecondPartsReview>2026-09-18T20:59:59+03:00</dateEndSecondPartsReview>
                  <procedureType>
                    <id>18</id>
                    <title>Запрос котировок</title>
                  </procedureType>
                  <contactEmail>zakupki@example.test</contactEmail>
                  <contactPhone>+7 000 000-00-00</contactPhone>
                  <contactPerson>Иванова Мария Петровна</contactPerson>
                  <currency>RUB</currency>
                  <organizer>
                    <id>851792</id>
                    <fullName><![CDATA[ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РГ-СНАБЖЕНИЕ"]]></fullName>
                    <inn>2203002720</inn>
                    <legal>
                      <index/>
                      <region/>
                      <city/>
                      <street/>
                      <house>119180, Г.МОСКВА, вн.тер.г. МУНИЦИПАЛЬНЫЙ ОКРУГ ЯКИМАНКА, УЛ БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                      <countryIsoNr/>
                    </legal>
                    <postal>
                      <index/>
                      <region/>
                      <city/>
                      <street/>
                      <house>119180, Г.МОСКВА, УЛ. БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                      <countryIsoNr/>
                    </postal>
                  </organizer>
                  <documents>
                    <document>
                      <id>20236402</id>
                      <filename>Извещение_инструмент_2_лота.docx</filename>
                      <file>https://api.tektorg.ru/open-api/documents/procedure/20236402</file>
                    </document>
                    <document>
                      <id>20236403</id>
                      <filename>Лот_1.zip</filename>
                      <file>https://api.tektorg.ru/open-api/documents/procedure/20236403</file>
                    </document>
                    <document>
                      <id>20236404</id>
                      <filename>Лот_2.zip</filename>
                      <file>https://api.tektorg.ru/open-api/documents/procedure/20236404</file>
                    </document>
                  </documents>
                  <lots>
                    <lot id="23097734">
                      <remoteId>210205</remoteId>
                      <number>2</number>
                      <subject>Поставка электро-бензоинструмента (лот 2) АО «Регионгаз-инвест»</subject>
                      <startPrice>2070487.88</startPrice>
                      <status>Архив</status>
                      <alternativeApplics>false</alternativeApplics>
                      <customers>
                        <customer>
                          <id>-195177</id>
                          <fullName><![CDATA[АКЦИОНЕРНОЕ ОБЩЕСТВО "РЕГИОНГАЗ-ИНВЕСТ"]]></fullName>
                          <inn>6659075136</inn>
                          <contactPerson/>
                          <contactPhone/>
                          <contactEmail/>
                          <legal>
                            <index/>
                            <region/>
                            <city/>
                            <street/>
                            <house>119180, Г.МОСКВА, вн.тер.г. МУНИЦИПАЛЬНЫЙ ОКРУГ ЯКИМАНКА, УЛ БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                            <countryIsoNr/>
                          </legal>
                          <postal>
                            <index/>
                            <region/>
                            <city/>
                            <street/>
                            <house>119180, Г.МОСКВА, УЛ. БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                            <countryIsoNr/>
                          </postal>
                        </customer>
                      </customers>
                      <deliveryPlaces>
                        <deliveryPlace>
                          <term>В соответствии с документацией о закупке</term>
                          <address>В соответствии с документацией о закупке</address>
                        </deliveryPlace>
                      </deliveryPlaces>
                      <nomenclature2>
                        <item>
                          <code>28.24.12.190</code>
                          <name>Инструменты ручные прочие с механизированным приводом, не включенные в другие группировки</name>
                        </item>
                      </nomenclature2>
                      <lotUnits>
                        <unit>
                          <name>Электро-бензоинструмент (Лот 2)</name>
                          <okeiCode>876</okeiCode>
                          <okpd2_code>28.24.12.190</okpd2_code>
                          <okved2_code>28.24</okved2_code>
                          <quantity>1</quantity>
                        </unit>
                      </lotUnits>
                    </lot>
                    <lot id="23097733">
                      <remoteId>210204</remoteId>
                      <number>1</number>
                      <subject>Поставка электро-бензоинструмента (лот 1) АО «Регионгаз-инвест»</subject>
                      <startPrice>1227415.87</startPrice>
                      <status>Архив</status>
                      <alternativeApplics>false</alternativeApplics>
                      <customers>
                        <customer>
                          <id>-195177</id>
                          <fullName><![CDATA[АКЦИОНЕРНОЕ ОБЩЕСТВО "РЕГИОНГАЗ-ИНВЕСТ"]]></fullName>
                          <inn>6659075136</inn>
                          <contactPerson/>
                          <contactPhone/>
                          <contactEmail/>
                          <legal>
                            <index/>
                            <region/>
                            <city/>
                            <street/>
                            <house>119180, Г.МОСКВА, вн.тер.г. МУНИЦИПАЛЬНЫЙ ОКРУГ ЯКИМАНКА, УЛ БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                            <countryIsoNr/>
                          </legal>
                          <postal>
                            <index/>
                            <region/>
                            <city/>
                            <street/>
                            <house>119180, Г.МОСКВА, УЛ. БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                            <countryIsoNr/>
                          </postal>
                        </customer>
                      </customers>
                      <deliveryPlaces>
                        <deliveryPlace>
                          <term>В соответствии с документацией о закупке</term>
                          <address>В соответствии с документацией о закупке</address>
                        </deliveryPlace>
                      </deliveryPlaces>
                      <nomenclature2>
                        <item>
                          <code>28.24.12.190</code>
                          <name>Инструменты ручные прочие с механизированным приводом, не включенные в другие группировки</name>
                        </item>
                      </nomenclature2>
                      <lotUnits>
                        <unit>
                          <name>Электро-бензоинструмент (лот 1)</name>
                          <okeiCode>876</okeiCode>
                          <okpd2_code>28.24.12.190</okpd2_code>
                          <okved2_code>28.24</okved2_code>
                          <quantity>1</quantity>
                        </unit>
                      </lotUnits>
                    </lot>
                  </lots>
                </procedure>
        <procedure id="232567">
                  <remoteId>232567</remoteId>
                  <url_to_showcase>https://www.tektorg.ru/223-fz/procedures/19911463</url_to_showcase>
                  <registryNumber>ЗП610102</registryNumber>
                  <title>Оказание услуг по техническому обслуживанию, текущему ремонту, кузовному ремонту и окраске деталей автотранспортных средств ООО «Оргэнергокапитал» в г. Ангарск.</title>
                  <datePublished>2026-10-01T17:34:54+03:00</datePublished>
                  <dateUpdated>2026-10-01T17:35:03+03:00</dateUpdated>
                  <dateEndRegistration>2026-10-12T12:00:00+03:00</dateEndRegistration>
                  <procedureType>
                    <id>21</id>
                    <title>Запрос предоставления ценовой информации</title>
                  </procedureType>
                  <contactEmail>zakupki@example.test</contactEmail>
                  <contactPhone>+7 000 000-00-00</contactPhone>
                  <contactPerson>Иванова Мария Петровна</contactPerson>
                  <currency>RUB</currency>
                  <organizer>
                    <id>851792</id>
                    <fullName><![CDATA[ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РГ-СНАБЖЕНИЕ"]]></fullName>
                    <inn>2203002720</inn>
                    <legal>
                      <index/>
                      <region/>
                      <city/>
                      <street/>
                      <house>119180, Г.МОСКВА, вн.тер.г. МУНИЦИПАЛЬНЫЙ ОКРУГ ЯКИМАНКА, УЛ БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                      <countryIsoNr/>
                    </legal>
                    <postal>
                      <index/>
                      <region/>
                      <city/>
                      <street/>
                      <house>119180, Г.МОСКВА, УЛ. БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                      <countryIsoNr/>
                    </postal>
                  </organizer>
                  <documents>
                    <document>
                      <id>20499346</id>
                      <filename>ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус).docx</filename>
                      <file>https://api.tektorg.ru/open-api/documents/procedure/20499346</file>
                    </document>
                    <document>
                      <id>20499347</id>
                      <filename>Приложение_№_2_Рекомендуемая_форма_ТКП_ЛадаЛаргус.xlsx</filename>
                      <file>https://api.tektorg.ru/open-api/documents/procedure/20499347</file>
                    </document>
                  </documents>
                  <lots>
                    <lot id="23283771">
                      <remoteId>213784</remoteId>
                      <number>1</number>
                      <subject>Оказание услуг по техническому обслуживанию, текущему ремонту, кузовному ремонту и окраске деталей автотранспортных средств ООО «Оргэнергокапитал» в г. Ангарск.</subject>
                      <status>Приём заявок</status>
                      <customers>
                        <customer>
                          <id>-790744</id>
                          <fullName><![CDATA[Общество с ограниченной ответственностью "ОРГЭНЕРГОКАПИТАЛ"]]></fullName>
                          <inn>5001110252</inn>
                          <contactPerson/>
                          <contactPhone/>
                          <contactEmail/>
                          <legal>
                            <index/>
                            <region/>
                            <city/>
                            <street/>
                            <house>119180, Г.МОСКВА, вн.тер.г. МУНИЦИПАЛЬНЫЙ ОКРУГ ЯКИМАНКА, УЛ БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                            <countryIsoNr/>
                          </legal>
                          <postal>
                            <index/>
                            <region/>
                            <city/>
                            <street/>
                            <house>119180, Г.МОСКВА, УЛ. БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2</house>
                            <countryIsoNr/>
                          </postal>
                        </customer>
                      </customers>
                      <deliveryPlaces>
                        <deliveryPlace>
                          <term>В соответствии с ТЗ</term>
                          <address>В соответствии с ТЗ</address>
                        </deliveryPlace>
                      </deliveryPlaces>
                      <nomenclature2>
                        <item>
                          <code>45.20.11.111</code>
                          <name>Услуги по регламентным работам (по видам технического обслуживания)</name>
                        </item>
                      </nomenclature2>
                      <lotUnits>
                        <unit>
                          <name>Оказание услуг по техническому обслуживанию, текущему ремонту, кузовному ремонту и окраске деталей автотранспортных средств ООО «Оргэнергокапитал» в г. Ангарск.</name>
                          <okeiCode/>
                          <okpd2_code>45.20.11.111</okpd2_code>
                          <okved2_code>45.20.1</okved2_code>
                          <quantity/>
                        </unit>
                      </lotUnits>
                    </lot>
                  </lots>
                </procedure>
        <procedure id="230471">
                  <remoteId>230471</remoteId>
                  <url_to_showcase>https://www.tektorg.ru/223-fz/procedures/19823894</url_to_showcase>
                  <registryNumber>ЗП6091269</registryNumber>
                  <eisRegistryNumber>32616377511</eisRegistryNumber>
                  <title>Яйцо куринное</title>
                  <datePublished>2026-09-15T08:49:02+03:00</datePublished>
                  <dateUpdated>2026-09-21T08:54:02+03:00</dateUpdated>
                  <dateEndRegistration>2026-09-21T08:00:00+03:00</dateEndRegistration>
                  <dateEndSecondPartsReview>2026-09-21T21:59:59+03:00</dateEndSecondPartsReview>
                  <procedureType>
                    <id>18</id>
                    <title>Запрос котировок</title>
                  </procedureType>
                  <contactEmail>zakupki@example.test</contactEmail>
                  <contactPhone>+7 000 000-00-00</contactPhone>
                  <contactPerson>Иванова Мария Петровна</contactPerson>
                  <reviewApplicsCity>с. Акшуат</reviewApplicsCity>
                  <currency>RUB</currency>
                  <organizer>
                    <id>617772</id>
                    <fullName><![CDATA[ОБЛАСТНОЕ ГОСУДАРСТВЕННОЕ АВТОНОМНОЕ УЧРЕЖДЕНИЕ СОЦИАЛЬНОГО ОБСЛУЖИВАНИЯ "ДОМ ДОБРА И ПОМОЩИ "БЛАГО"]]></fullName>
                    <inn>7304004049</inn>
                    <legal>
                      <index>433741</index>
                      <region>Ульяновская область</region>
                      <city>Барышский район</city>
                      <street>УЛ. КРАСНАЯ</street>
                      <house>Д.21А</house>
                      <countryIsoNr>643</countryIsoNr>
                    </legal>
                    <postal>
                      <index>433741</index>
                      <region>Ульяновская область</region>
                      <city>Барышский район</city>
                      <street>УЛ. КРАСНАЯ</street>
                      <house>Д.21А</house>
                      <countryIsoNr>643</countryIsoNr>
                    </postal>
                  </organizer>
                  <documents>
                    <document>
                      <id>20365162</id>
                      <filename>1-Яйцо.docx</filename>
                      <file>https://api.tektorg.ru/open-api/documents/procedure/20365162</file>
                    </document>
                  </documents>
                  <lots>
                    <lot id="23164548">
                      <remoteId>211976</remoteId>
                      <number>1</number>
                      <subject>Яйцо куринное</subject>
                      <startPrice>137640</startPrice>
                      <status>Архив</status>
                      <alternativeApplics>false</alternativeApplics>
                      <customers>
                        <customer>
                          <id>-617772</id>
                          <fullName><![CDATA[ОБЛАСТНОЕ ГОСУДАРСТВЕННОЕ АВТОНОМНОЕ УЧРЕЖДЕНИЕ СОЦИАЛЬНОГО ОБСЛУЖИВАНИЯ "ДОМ ДОБРА И ПОМОЩИ "БЛАГО"]]></fullName>
                          <inn>7304004049</inn>
                          <contactPerson/>
                          <contactPhone/>
                          <contactEmail/>
                          <legal>
                            <index>433741</index>
                            <region>Ульяновская область</region>
                            <city>Барышский район</city>
                            <street>УЛ. КРАСНАЯ</street>
                            <house>Д.21А</house>
                            <countryIsoNr>643</countryIsoNr>
                          </legal>
                          <postal>
                            <index>433741</index>
                            <region>Ульяновская область</region>
                            <city>Барышский район</city>
                            <street>УЛ. КРАСНАЯ</street>
                            <house>Д.21А</house>
                            <countryIsoNr>643</countryIsoNr>
                          </postal>
                        </customer>
                      </customers>
                      <deliveryPlaces>
                        <deliveryPlace>
                          <term>В соответствии с документацией о закупке</term>
                          <address>Ульяновская область</address>
                        </deliveryPlace>
                      </deliveryPlaces>
                      <nomenclature2>
                        <item>
                          <code>01.47.21.000</code>
                          <name>Яйца куриные в скорлупе свежие</name>
                        </item>
                      </nomenclature2>
                      <lotUnits>
                        <unit>
                          <name>Позиция номер 1</name>
                          <okeiCode>796</okeiCode>
                          <okpd2_code>01.47.21.000</okpd2_code>
                          <okved2_code>01.47.2</okved2_code>
                          <quantity>12000</quantity>
                        </unit>
                      </lotUnits>
                    </lot>
                  </lots>
                </procedure>
      </procedures>
    </SOAP-ENV:proceduresResponse>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

/**
 * Тот же ответ, но у первой процедуры один документ снят с публикации: вместо
 * `<file>` приходит `<removed>`.
 *
 * Этот случай описан в WSDL как выбор между двумя элементами (`xsd:choice`), но в
 * 105 живых процедурах не встретился ни разу — поэтому блок документов собран по
 * схеме, а не скопирован из ответа. Адреса у снятого документа нет, и пытаться
 * скачать его нельзя: площадка отдаст страницу ошибки, а парсер примет её за текст
 * документа.
 */
export const TEKTORG_REMOVED_DOCUMENT = TEKTORG_LIVE_RESPONSE.replace(
  /<documents>[\s\S]*?<\/documents>/,
  `<documents>
          <document>
            <id>20499346</id>
            <filename>Снятый_с_публикации_документ.docx</filename>
            <removed>true</removed>
          </document>
          <document>
            <id>20499347</id>
            <filename>Приложение_№_2_Рекомендуемая_форма_ТКП_ЛадаЛаргус.xlsx</filename>
            <file>https://api.tektorg.ru/open-api/documents/procedure/20499347</file>
          </document>
        </documents>`,
);

/**
 * Пустая страница: конверт целый, процедур ноль.
 *
 * Собран по схеме (в `<procedures>` может не быть ни одного `<procedure>`), в живом
 * ответе такой страницы не попадалось. Отличать пустую выдачу от ошибки разбора
 * нужно обязательно: «новых закупок нет» и «площадка ответила ерундой» — разные
 * сообщения оператору.
 */
export const TEKTORG_EMPTY_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Body>
    <SOAP-ENV:proceduresResponse>
      <totalProcedures>0</totalProcedures>
      <currentPage>1</currentPage>
      <totalPage>0</totalPage>
      <limitProceduresInPage>100</limitProceduresInPage>
      <sectionName>223-ФЗ и Коммерческие закупки</sectionName>
      <sectionCode>zakupki</sectionCode>
      <procedures/>
    </SOAP-ENV:proceduresResponse>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

/**
 * Ответ с ошибкой площадки.
 *
 * Конверт собран по SOAP 1.1, а не скопирован: за все зонды 01.10.2026 ТЭК-Торг ни
 * разу не ответил Fault. Проверить именно тело важно потому, что успешный ответ
 * площадка отдаёт с `Content-Type: text/html` — по заголовку отличить ошибку от
 * выдачи нельзя.
 */
export const TEKTORG_FAULT = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Body>
    <SOAP-ENV:Fault>
      <faultcode>SOAP-ENV:Server</faultcode>
      <faultstring>Некорректный период обновления</faultstring>
    </SOAP-ENV:Fault>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

/**
 * Оборванный ответ: соединение закрылось после первой процедуры, конверт не
 * закрыт. Первая процедура при этом выглядит целой, и наивный разбор отдал бы её
 * как полную выдачу — молча потерять две трети закупок хуже, чем упасть.
 */
export const TEKTORG_TRUNCATED = TEKTORG_LIVE_RESPONSE.slice(
  0,
  TEKTORG_LIVE_RESPONSE.indexOf("</procedure>") + "</procedure>".length,
);
