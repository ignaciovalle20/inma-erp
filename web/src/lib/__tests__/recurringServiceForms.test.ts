/**
 * The new-service form by the active company's country: Chile asks
 * neither country nor currency (fixed CLP); Uruguay asks the currency,
 * USD or UYU, required and with nothing preselected.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => {}, useRouter: () => ({ push: () => {} }) }));

import { NewRecurringServiceForm } from "@/app/companies/[id]/recurring-services/services/new/form";

function render(country: "CL" | "UY" | null) {
  return renderToString(
    createElement(NewRecurringServiceForm, {
      companyId: "company-1",
      clients: [],
      businessAreas: [],
      country,
    }),
  );
}

describe("new recurring service form", () => {
  it("Chile: no currency selector and no country field, CLP submitted", () => {
    const html = render("CL");
    expect(html).not.toMatch(/<select[^>]*id="currency"/);
    expect(html).toMatch(/<input type="hidden" name="currency" value="CLP"/);
    expect(html).toContain("Chile · CLP");
    expect(html).not.toMatch(/name="country"/);
  });

  it("Uruguay: required USD/UYU selector with nothing chosen", () => {
    const html = render("UY");
    const select = html.match(/<select[^>]*id="currency"[^>]*>([\s\S]*?)<\/select>/);
    expect(select).not.toBeNull();
    expect(select![0]).toMatch(/required/);
    const options = [...select![1].matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(["", "USD", "UYU"]);
    // The empty placeholder is the selected one.
    expect(select![1]).toMatch(/<option value="" disabled="" selected="">/);
    expect(html).not.toMatch(/name="country"/);
  });
});
