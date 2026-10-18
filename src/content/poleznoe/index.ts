import { createRegistry } from "./registry";
import type { Article } from "./types";
import { article as tenderyNaStroitelstvoIRemont } from "./tendery-na-stroitelstvo-i-remont";
import { article as kakOcenitTenderZa10Minut } from "./kak-ocenit-tender-za-10-minut";
import { article as a44Fz223Fz615PpRaznica } from "./44-fz-223-fz-615-pp-raznica";
import { article as tenderyBuryatiya } from "./tendery-buryatiya";
import { article as kommercheskieZakupkiStroitelstvo } from "./kommercheskie-zakupki-stroitelstvo";
import { article as kapremont615PpPredkvalifikaciya } from "./kapremont-615-pp-predkvalifikaciya";
import { article as kakChitatDokumentaciyuZakupki } from "./kak-chitat-dokumentaciyu-zakupki";
import { article as tipovyeUsloviya44Fz } from "./tipovye-usloviya-44-fz";
import { article as srokOplatyPo44Fz } from "./srok-oplaty-po-44-fz";
import { article as zhalobaVFasNaDokumentaciyu } from "./zhaloba-v-fas-na-dokumentaciyu";
import { article as sroDlyaGoszakupok } from "./sro-dlya-goszakupok";
import { article as dopolnitelnyeTrebovaniyaOpytPp2571 } from "./dopolnitelnye-trebovaniya-opyt-pp-2571";
import { article as obespechenieZayavkiIKontrakta } from "./obespechenie-zayavki-i-kontrakta";
import { article as kaznacheyskoeSoprovozhdenie } from "./kaznacheyskoe-soprovozhdenie";
import { article as iiDlyaAnalizaTenderov } from "./ii-dlya-analiza-tenderov";
import { article as kakProveritSmetuZakazchika } from "./kak-proverit-smetu-zakazchika";
import { article as minimalnayaCenaUchastiya } from "./minimalnaya-cena-uchastiya";
import { article as smetaPoVorBezSmetyZakazchika } from "./smeta-po-vor-bez-smety-zakazchika";
import { article as nmckVStroitelstve } from "./nmck-v-stroitelstve";
import { article as resursnoIndeksnyyMetod421Pr } from "./resursno-indeksnyy-metod-421-pr";
import { article as fgisCsCenyResursov } from "./fgis-cs-ceny-resursov";
import { article as elektronnyyAuktsionDlyaPodryadchika } from "./elektronnyy-auktsion-dlya-podryadchika";
import { article as zaprosKotirovokVElektronnoyForme } from "./zapros-kotirovok-v-elektronnoy-forme";
import { article as antidempingovyeMery } from "./antidempingovye-mery";
import { article as priemkaIIspolnenieKontrakta } from "./priemka-i-ispolnenie-kontrakta";
import { article as kakNePopastVRnp } from "./kak-ne-popast-v-rnp";

/**
 * Реестр статей раздела «Полезное».
 *
 * Как добавить статью: модуль `<slug>.ts` экспортирует `export const article: Article`.
 * Здесь нужны две строки — импорт и запись в массив:
 *
 *   import { article as srokOplatyPo44fz } from "./srok-oplaty-po-44-fz";
 *   export const ARTICLES: Article[] = [..., srokOplatyPo44fz];
 *
 * Порядок в массиве — порядок на странице внутри рубрики. Страница статьи, карта
 * сайта, llms.txt и проверка в articles.test.ts строятся из этого списка, а
 * забытая регистрация ловится тем же тестом (файл есть, а в реестре нет).
 */

/** Порядок внутри кластера — порядок на странице «Полезное». */
export const ARTICLES: Article[] = [
  tenderyNaStroitelstvoIRemont,
  kakOcenitTenderZa10Minut,
  a44Fz223Fz615PpRaznica,
  tenderyBuryatiya,
  kommercheskieZakupkiStroitelstvo,
  kapremont615PpPredkvalifikaciya,
  kakChitatDokumentaciyuZakupki,
  tipovyeUsloviya44Fz,
  srokOplatyPo44Fz,
  zhalobaVFasNaDokumentaciyu,
  sroDlyaGoszakupok,
  dopolnitelnyeTrebovaniyaOpytPp2571,
  obespechenieZayavkiIKontrakta,
  kaznacheyskoeSoprovozhdenie,
  iiDlyaAnalizaTenderov,
  kakProveritSmetuZakazchika,
  minimalnayaCenaUchastiya,
  smetaPoVorBezSmetyZakazchika,
  nmckVStroitelstve,
  resursnoIndeksnyyMetod421Pr,
  fgisCsCenyResursov,
  elektronnyyAuktsionDlyaPodryadchika,
  zaprosKotirovokVElektronnoyForme,
  antidempingovyeMery,
  priemkaIIspolnenieKontrakta,
  kakNePopastVRnp,
];

export const { getArticle, articlesByCluster, relatedArticles, lastUpdated } = createRegistry(ARTICLES);

export { CLUSTERS, CLUSTER_TITLES } from "./clusters";
export type { Article, ArticleCluster } from "./types";
