import type { Metadata } from "next";
import { Suspense } from "react";

import { EstimateUploadView } from "@/components/estimate/EstimateUploadView";

export const metadata: Metadata = {
  title: "Расчёт сметы",
  description:
    "Загрузите документацию — и получите локальный сметный расчёт по форме приказа 421/пр.",
};

/*
  Suspense обязателен: экран читает `?job=` через useSearchParams (расчёт из списка «Мои расчёты» и ссылка
  из письма «смета готова»), а без границы сборка страницы падает на этом хуке.
*/
export default function EstimatePage() {
  return (
    <Suspense fallback={null}>
      <EstimateUploadView />
    </Suspense>
  );
}
