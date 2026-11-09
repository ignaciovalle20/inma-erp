"use client";

import { useRouter } from "next/navigation";

/**
 * Client picker of the projects list (`?cliente=<id>`). Navigates by
 * querystring like the year filter: `keep` is the rest of the view (tab,
 * year, search, period); the page number is dropped, a new filter starts at
 * page 1. The filtering itself runs on the server (listProjects).
 */
export function ProjectClientFilter({
  basePath,
  clients,
  clientId,
  keep,
}: {
  basePath: string;
  clients: { id: string; name: string }[];
  clientId: string | null;
  keep: Record<string, string>;
}) {
  const router = useRouter();

  return (
    <select
      value={clientId ?? ""}
      onChange={(event) => {
        const params = new URLSearchParams(keep);
        params.delete("cliente");
        if (event.target.value) params.set("cliente", event.target.value);
        const qs = params.toString();
        router.push(qs ? `${basePath}?${qs}` : basePath);
      }}
      aria-label="Filtrar por cliente"
      className="control-sm max-w-[240px]"
    >
      <option value="">Todos los clientes</option>
      {clients.map((client) => (
        <option key={client.id} value={client.id}>
          {client.name}
        </option>
      ))}
    </select>
  );
}
