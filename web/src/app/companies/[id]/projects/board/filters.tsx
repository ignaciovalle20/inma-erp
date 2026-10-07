"use client";

import { useRouter } from "next/navigation";

/**
 * Área/Responsable filters for the kanban board -- navigates by
 * querystring, same pattern as PeriodPicker (a plain <select> that
 * pushes a new URL on change, no client-side filtering state to keep
 * in sync with the server-rendered columns).
 */
export function BoardFilters({
  basePath,
  areas,
  responsibles,
  area,
  responsible,
}: {
  basePath: string;
  areas: { id: string; name: string }[];
  responsibles: string[];
  area: string;
  responsible: string;
}) {
  const router = useRouter();

  function navigate(nextArea: string, nextResponsible: string) {
    const params = new URLSearchParams();
    if (nextArea) params.set("area", nextArea);
    if (nextResponsible) params.set("responsible", nextResponsible);
    const query = params.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  }

  return (
    // Two equal columns on a phone (a long option must not widen the page),
    // side by side and capped on wider screens.
    <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
      <select
        value={area}
        onChange={(event) => navigate(event.target.value, responsible)}
        aria-label="Filtrar por área"
        className="control-sm w-full sm:w-auto sm:max-w-[200px]"
      >
        <option value="">Todas las áreas</option>
        {areas.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <select
        value={responsible}
        onChange={(event) => navigate(area, event.target.value)}
        aria-label="Filtrar por responsable"
        className="control-sm w-full sm:w-auto sm:max-w-[220px]"
      >
        <option value="">Todos los responsables</option>
        {responsibles.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </div>
  );
}
