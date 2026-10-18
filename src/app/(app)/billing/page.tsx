import type { Metadata } from "next";
import { BillingView } from "@/components/billing/BillingView";

export const metadata: Metadata = { title: "Оплата и тарифы" };

export default function BillingPage() {
  return <BillingView />;
}
