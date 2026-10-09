"use client";

import { useRouter } from "next/navigation";

/**
 * Year picker of the "Finalizados" tab -- navigates by querystring, same
 * pattern as the board's BoardFilters. Only years that have finished jobs
 * are offered.
 */
export function ProjectYearFilter({
  basePath,
  years,
  year,
}: {
  basePath: string;
  years: number[];
  year: number | null;
}) {
  const router = useRouter();

  return (
    <select
      value={year ?? ""}
      onChange={(event) => {
        const params = new URLSearchParams({ estado: "finalizados" });
        if (event.target.value) params.set("anio", event.target.value);
        router.push(`${basePath}?${params.toString()}`);
      }}
      aria-label="Filtrar por año de cierre"
      className="control-sm"
    >
      <option value="">Todos los años</option>
      {years.map((item) => (
        <option key={item} value={item}>
          {item}
        </option>
      ))}
    </select>
  );
}
