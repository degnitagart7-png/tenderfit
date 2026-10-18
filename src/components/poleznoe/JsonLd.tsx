import { jsonForScript } from "@/content/poleznoe/jsonld";

/**
 * Тег микроразметки. dangerouslySetInnerHTML здесь неизбежен: React экранирует
 * содержимое <script> как HTML-текст и ломает JSON. Опасные символы заранее
 * экранирует jsonForScript, поэтому текст статьи не может закрыть тег.
 */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonForScript(data) }} />;
}
