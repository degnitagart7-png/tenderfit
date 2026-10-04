import { TenderDetailView } from "@/components/tenders/TenderDetailView";

export const metadata = { title: "Карточка закупки" };

export default function TenderDetailPage({ params }: { params: { id: string } }) {
  return <TenderDetailView tenderId={params.id} />;
}
