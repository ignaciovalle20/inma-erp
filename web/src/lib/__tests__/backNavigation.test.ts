/** "Volver": which screen it goes to, and whether through the history or the link. */
import { describe, it, expect } from "vitest";
import { backAction, backTarget, isFormPage, listUrl, sameUrl, withVolver } from "@/lib/backNavigation";

describe("listUrl and withVolver", () => {
  it("keeps the filters of the list, without what is not one", () => {
    expect(listUrl("/companies/c1/costs", { period: "2026-10", q: undefined, sort: "total" })).toBe(
      "/companies/c1/costs?period=2026-10&sort=total",
    );
    expect(listUrl("/companies/c1/costs", { volver: "/x", sugeridas: "1" }, ["sugeridas"])).toBe("/companies/c1/costs");
  });

  it("carries the list's URL in one parameter", () => {
    const href = withVolver("/companies/c1/costs/d1", "/companies/c1/costs?period=2026-10&sort=total");
    expect(href).toBe("/companies/c1/costs/d1?volver=%2Fcompanies%2Fc1%2Fcosts%3Fperiod%3D2026-10%26sort%3Dtotal");
    expect(new URL(href, "http://x").searchParams.get("volver")).toBe("/companies/c1/costs?period=2026-10&sort=total");
    expect(withVolver("/a?b=1", "/c")).toBe("/a?b=1&volver=%2Fc");
    expect(withVolver("/a", null)).toBe("/a");
  });
});

describe("backTarget", () => {
  const fallback = { href: "/companies/c1/costs", label: "Volver a documentos de costo" };

  it("goes where ?volver= says, naming the screen", () => {
    expect(backTarget("c1", "/companies/c1/costs?period=2026-10", fallback)).toEqual({
      href: "/companies/c1/costs?period=2026-10",
      label: "Volver a Costos",
      exact: true,
    });
    expect(backTarget("c1", "/companies/c1/projects/board?area=a", fallback).label).toBe("Volver al tablero");
    expect(backTarget("c1", "/companies/c1/projects/p1", fallback).label).toBe("Volver al trabajo");
  });

  it("ignores a target outside the company", () => {
    expect(backTarget("c1", "/companies/c2/costs", fallback)).toEqual(fallback);
    expect(backTarget("c1", "https://evil.example/companies/c1/costs", fallback)).toEqual(fallback);
    expect(backTarget("c1", "/companies/c1//evil.example", fallback)).toEqual(fallback);
    expect(backTarget("c1", undefined, fallback)).toEqual(fallback);
  });
});

describe("backAction", () => {
  const list = "/companies/c1/costs?period=2026-10";

  it("follows the link when the tab has no previous screen", () => {
    expect(backAction({ href: list, exact: true }, null)).toBe("link");
    expect(backAction({ href: list }, null)).toBe("link");
  });

  it("uses the history when it lands exactly on the target, which restores the scroll", () => {
    expect(backAction({ href: list, exact: true }, list)).toBe("history");
  });

  it("follows the link when the history would land somewhere else", () => {
    expect(backAction({ href: list, exact: true }, "/companies/c1/costs/d1/edit")).toBe("link");
    expect(backAction({ href: list, exact: true }, "/companies/c1/costs?period=2026-09")).toBe("link");
  });

  it("uses the history for a target without ?volver=, unless it would reopen a form", () => {
    expect(backAction({ href: "/companies/c1/projects/p1" }, "/companies/c1/recurring-services")).toBe("history");
    expect(backAction({ href: "/companies/c1/projects/p1" }, "/companies/c1/projects/p1/edit")).toBe("link");
    expect(backAction({ href: "/companies/c1/projects/p1" }, "/companies/c1/projects/p1/edit?volver=x")).toBe("link");
  });
});

describe("sameUrl and isFormPage", () => {
  it("does not depend on encoding or order", () => {
    expect(sameUrl("/a?x=1&y=a b", "/a?y=a%20b&x=1")).toBe(true);
    expect(sameUrl("/a?x=1", "/a?x=2")).toBe(false);
  });

  it("knows a form from a page that only shows", () => {
    expect(isFormPage("/companies/c1/sales/new")).toBe(true);
    expect(isFormPage("/companies/c1/costs/d1/assign?volver=x")).toBe(true);
    expect(isFormPage("/companies/c1/costs/d1")).toBe(false);
    expect(isFormPage("/companies/c1/costs/new-thing")).toBe(false);
  });
});
