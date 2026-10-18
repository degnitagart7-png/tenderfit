"use client";

import { useEffect, useState } from "react";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { CompanyProfileForm } from "@/components/settings/CompanyProfileForm";
import { LoadingSkeleton } from "@/components/ui/primitives";

export default function SettingsProfilePage() {
  const [initial, setInitial] = useState(() => null as ReturnType<typeof companyProfileRepository.get> | null);

  useEffect(() => {
    setInitial(companyProfileRepository.get());
  }, []);

  if (!initial) return <LoadingSkeleton rows={8} />;
  return <CompanyProfileForm initial={initial} />;
}
