import type { Metadata } from "next";

import { EstimateUploadView } from "@/components/estimate/EstimateUploadView";

export const metadata: Metadata = {
  title: "Расчёт сметы",
  description:
    "Загрузите документацию — и получите локальный сметный расчёт по форме приказа 421/пр.",
};

export default function EstimatePage() {
  return <EstimateUploadView />;
}
