/**
 * "Eliminar servicio": the blockers listed on the service's page, the
 * confirmation text, and the button only enabled with nothing assigned.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { deletionConfirmText, groupDeletionBlockers } from "@/lib/recurringServiceDeletion";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => {}, useRouter: () => ({ push: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { DeleteServiceSection } from "@/app/companies/[id]/recurring-services/services/[recurringServiceId]/delete-service";

describe("deletion blockers", () => {
  it("groups them by kind in a fixed order, each with where to remove it", () => {
    const groups = groupDeletionBlockers([
      { kind: "cost", label: "STARLINK del 20/08/2026 → costo de agosto 2026 (confirmada)" },
      { kind: "sales", label: "Factura 2619 → ciclo junio 2026 (confirmada)" },
      { kind: "cost", label: "STARLINK del 06/09/2026 → costo de septiembre 2026 (confirmada)" },
    ]);
    expect(groups.map((group) => [group.kind, group.items.length])).toEqual([
      ["sales", 1],
      ["cost", 2],
    ]);
    expect(groups[1].howTo).toMatch(/Asignar a servicios/);
  });

  it("nothing assigned: no groups", () => {
    expect(groupDeletionBlockers([])).toEqual([]);
  });

  it("says what goes with the service", () => {
    expect(deletionConfirmText("EBCO WIND", 11, 10)).toBe(
      '¿Eliminar "EBCO WIND"? Se borran el servicio y sus 11 ciclos y 10 períodos de costo. No se puede deshacer.',
    );
    expect(deletionConfirmText("Hosting", 1, 0)).toBe('¿Eliminar "Hosting"? Se borran el servicio y sus 1 ciclo. No se puede deshacer.');
  });
});

describe("Eliminar servicio button", () => {
  const render = (props: Partial<Parameters<typeof DeleteServiceSection>[0]>) =>
    renderToString(
      createElement(DeleteServiceSection, {
        companyId: "company-1",
        serviceId: "service-1",
        confirmText: "¿Eliminar?",
        groups: [],
        failed: false,
        ...props,
      }),
    );
  // The opening tag's `disabled=""` attribute (its class has Tailwind `disabled:` variants).
  const button = (html: string) => (html.match(/<button[^>]*>Eliminar servicio<\/button>/)?.[0] ?? "").replace(/class="[^"]*"/, "");

  it("is enabled when nothing is assigned", () => {
    expect(button(render({}))).not.toMatch(/disabled/);
  });

  it("is disabled and lists what to remove while invoices are assigned", () => {
    const html = render({
      groups: groupDeletionBlockers([{ kind: "cost", label: "STARLINK del 20/08/2026 → costo de agosto 2026 (confirmada)" }]),
    });
    expect(button(html)).toMatch(/disabled/);
    expect(html).toContain("STARLINK del 20/08/2026");
    expect(html).toContain("Facturas de compra asignadas");
  });

  it("is disabled when the checks could not be read", () => {
    expect(button(render({ failed: true }))).toMatch(/disabled/);
  });
});
