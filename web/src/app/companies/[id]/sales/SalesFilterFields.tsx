"use client";

import { useState } from "react";
import { Combobox } from "@/components/Combobox";

export function SalesFilterFields({
  clients,
  projects,
  areas,
  defaultClientId,
  defaultProjectId,
  defaultBusinessAreaId,
}: {
  clients: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  areas: { id: string; name: string }[];
  defaultClientId: string;
  defaultProjectId: string;
  defaultBusinessAreaId: string;
}) {
  const [clientId, setClientId] = useState(defaultClientId);
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [businessAreaId, setBusinessAreaId] = useState(defaultBusinessAreaId);

  return (
    <>
      <div className="w-[180px]">
        <Combobox
          id="clientId"
          name="clientId"
          value={clientId}
          onChange={setClientId}
          placeholder="Cliente"
          options={clients.map((client) => ({ value: client.id, label: client.name }))}
        />
      </div>
      <div className="w-[180px]">
        <Combobox
          id="projectId"
          name="projectId"
          value={projectId}
          onChange={setProjectId}
          placeholder="Proyecto"
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
        />
      </div>
      <div className="w-[160px]">
        <Combobox
          id="businessAreaId"
          name="businessAreaId"
          value={businessAreaId}
          onChange={setBusinessAreaId}
          placeholder="Área"
          options={areas.map((area) => ({ value: area.id, label: area.name }))}
        />
      </div>
    </>
  );
}
