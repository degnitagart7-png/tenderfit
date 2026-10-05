"use client";

import { useEffect, useState } from "react";

import { ServerProfilesCard } from "@/components/settings/ServerProfilesCard";
import type { SearchProfile } from "@/domain/entities";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";

/**
 * Раздел владельца. В меню его нет: клиентам он не нужен, а запись внутри
 * закрыта ключом владельца (ADMIN_TOKEN), так что адрес страницы не секрет.
 */
export default function SettingsAdminPage() {
  const [profiles, setProfiles] = useState<SearchProfile[]>([]);

  useEffect(() => {
    setProfiles(searchProfileRepository.getAll());
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
        Администрирование
      </h1>
      <ServerProfilesCard profiles={profiles} />
    </div>
  );
}
