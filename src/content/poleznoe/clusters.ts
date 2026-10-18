import type { ArticleCluster } from "./types";

/**
 * Рубрики раздела «Полезное».
 *
 * Порядок здесь — порядок на странице /poleznoe и в llms.txt: от поиска закупки
 * к участию и исполнению, как идёт сам процесс. Описание рубрики попадает в
 * llms.txt и на индексную страницу: ИИ-ассистент по нему понимает, в какой
 * группе искать ответ.
 */
export interface ClusterInfo {
  id: ArticleCluster;
  title: string;
  description: string;
}

export const CLUSTERS: readonly ClusterInfo[] = [
  {
    id: "search",
    title: "Поиск и выбор закупок",
    description: "Где искать закупки, как отбирать подходящие и не тратить время на чужие.",
  },
  {
    id: "documents",
    title: "Документация и риски",
    description: "Что смотреть в документации и проекте контракта, чтобы не попасть на штрафы и расторжение.",
  },
  {
    id: "estimate",
    title: "Смета и цена",
    description: "Как проверить смету заказчика, посчитать свою и понять, до какой цены можно снижаться.",
  },
  {
    id: "participation",
    title: "Участие и исполнение",
    description: "Заявка, обеспечение, СРО, жалобы и расчёты по контракту: от подачи до оплаты.",
  },
];

/** Названия рубрик по коду. */
export const CLUSTER_TITLES: Record<ArticleCluster, string> = {
  search: "Поиск и выбор закупок",
  documents: "Документация и риски",
  estimate: "Смета и цена",
  participation: "Участие и исполнение",
};
