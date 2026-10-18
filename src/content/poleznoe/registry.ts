import { CLUSTERS, type ClusterInfo } from "./clusters";
import type { Article } from "./types";

/**
 * Выборки из списка статей.
 *
 * Вынесены из index.ts и принимают список, а не читают его из модуля: так тесты
 * страниц подставляют свой список статей (vi.mock реестра), а все выборки
 * продолжают работать на нём.
 */

export interface ClusterGroup extends ClusterInfo {
  articles: Article[];
}

export function createRegistry(list: readonly Article[]) {
  /** Статья по адресу или undefined. */
  const getArticle = (slug: string): Article | undefined => list.find((a) => a.slug === slug);

  /** Статьи по рубрикам в порядке CLUSTERS; пустые рубрики не возвращаются. */
  const articlesByCluster = (): ClusterGroup[] =>
    CLUSTERS.map((cluster) => ({ ...cluster, articles: list.filter((a) => a.cluster === cluster.id) })).filter(
      (group) => group.articles.length > 0,
    );

  /**
   * Связанные статьи: сначала те, что автор указал в related, затем — из той же
   * рубрики, если указанных не хватило (битая ссылка не должна оставлять блок
   * «Читайте также» пустым). Не более четырёх, сама статья не возвращается.
   */
  const relatedArticles = (article: Article): Article[] => {
    const picked: Article[] = [];
    const add = (candidate: Article | undefined): void => {
      if (!candidate || candidate.slug === article.slug) return;
      if (picked.some((p) => p.slug === candidate.slug)) return;
      picked.push(candidate);
    };
    for (const slug of article.related) add(getArticle(slug));
    if (picked.length < 2) {
      for (const candidate of list) if (candidate.cluster === article.cluster) add(candidate);
    }
    return picked.slice(0, 4);
  };

  /** Самая поздняя правка: дата изменения индексной страницы и карты сайта. */
  const lastUpdated = (): string | undefined =>
    [...list.map((a) => a.updated)].sort().reverse()[0];

  return { getArticle, articlesByCluster, relatedArticles, lastUpdated };
}
