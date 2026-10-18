import type { Metadata } from "next";

import { DemoFeedView } from "@/components/demo/DemoFeedView";

export const metadata: Metadata = {
  title: "Демо-лента закупок",
  description:
    "Лента закупок с оценкой «участвовать или нет» на вымышленных данных — без регистрации. Карточка, анализ документации и смета открываются после входа.",
  alternates: { canonical: "/demo" },
};

export default function DemoPage() {
  return <DemoFeedView />;
}
