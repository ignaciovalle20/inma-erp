import { getSession, getCompanyForEdit } from "@/lib/dal";
import { buildSalesCsv } from "@/lib/salesExport";
import { loadSalesView, type SalesSearchParams } from "../salesView";

export const runtime = "nodejs";

/**
 * CSV export of the sales list (docs/cambios-flujo-v2.md 4.2), with the
 * exact filters of the page: the query string is the page's own.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const user = await getSession();
  if (!user) {
    return new Response("Iniciá sesión para exportar.", { status: 401 });
  }

  const membership = await getCompanyForEdit(id);
  if (!membership) {
    return new Response("No tenés acceso a esta empresa.", { status: 403 });
  }

  const searchParams: SalesSearchParams = Object.fromEntries(new URL(request.url).searchParams);
  const view = await loadSalesView(id, searchParams);

  // An empty file would read as "no sales": say what failed instead.
  if (view.error) {
    return new Response(view.error, { status: 500 });
  }

  const csv = buildSalesCsv(
    view.rows.map((row) => ({
      documentDate: row.document_date,
      documentType: row.document_type,
      documentNumber: row.document_number,
      clientName: row.client_name,
      areaName: row.business_area_name,
      projectName: row.project_name,
      netAmount: row.net_amount,
      cost: row.cost,
      profit: row.profit,
      marginPct: row.marginPct,
      paymentStatus: row.payment_status,
      dueDate: row.due_date,
      annulledBy: row.annulment_partner_number,
      voided: row.voided,
    })),
  );

  const today = new Date().toISOString().slice(0, 10);
  const safeName = membership.company.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ventas-${safeName || "empresa"}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
