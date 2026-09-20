import "server-only";

import {
  getClients,
  getExistingDocumentsByNumber,
  getPairableInvoices,
  getProjectBillingBalances,
  getUnnumberedSales,
} from "@/lib/dal";
import {
  classifyDocument,
  documentKey,
  normalizeClientName,
  normalizeRut,
  suggestAdoptions,
  suggestCreditNotePairs,
  suggestProjectLinks,
  summarize,
  validateNuboxRows,
  type Classification,
  type ExistingDocument,
  type ImportSummary,
  type JobBalance,
  type NuboxDocument,
  type NuboxRowResult,
  type PairingInvoice,
} from "@/lib/nubox";

/**
 * Everything the Nubox preview shows and the commit re-checks. Shared by
 * both Server Actions so they can never disagree: the commit does not
 * trust what the browser says the analysis was, it recomputes it.
 */

/**
 * completeRut: matched by name because the stored client has no RUT yet;
 * the import fills it in (the preview lists every one of these).
 */
export type ClientMatch = { id: string; name: string; completeRut?: boolean } | null;

/** A sale already loaded without a folio that no Nubox invoice claimed. */
export type LeftoverSale = { clientName: string; documentDate: string; netAmount: number };

export type CreditNoteView = {
  documentNumber: string;
  clientName: string;
  documentDate: string;
  netAmount: number;
  /**
   * auto: one candidate, pairs by itself. choose: several candidates.
   * none: no candidate (goes to pendientes). paired: already paired in the
   * database, nothing to do.
   */
  state: "auto" | "choose" | "none" | "paired";
  autoPairedWith: string | null;
  candidates: { documentNumber: string; documentDate: string; inFile: boolean }[];
};

export type InvoiceLinkView = {
  documentNumber: string;
  rowNumber: number;
  clientId: string;
  clientName: string;
  documentDate: string;
  netAmount: number;
  suggestedProjectId: string | null;
};

export type NuboxAnalysis = {
  results: NuboxRowResult[];
  classifications: Map<number, Classification>;
  summary: ImportSummary;
  /** RUT -> matched client, or null when it will be created. */
  clientByRut: Map<string, ClientMatch>;
  newClients: { rut: string; name: string }[];
  clientsToComplete: { id: string; storedName: string; fileName: string; rut: string }[];
  leftoverSales: LeftoverSale[];
  creditNotes: CreditNoteView[];
  invoiceLinks: InvoiceLinkView[];
  jobs: JobBalance[];
};

export async function analyzeNuboxRows(
  companyId: string,
  rows: Record<string, string>[],
): Promise<NuboxAnalysis> {
  const validated = validateNuboxRows(rows);

  const clients = await getClients(companyId);
  const clientsByRut = new Map<string, { id: string; name: string }[]>();
  const rutByClientId = new Map<string, string>();
  // Clients loaded before Nubox usually have no RUT: they are found by name.
  const clientsByName = new Map<string, { id: string; name: string }[]>();
  for (const client of clients) {
    const rut = normalizeRut(client.tax_id);
    if (!rut) {
      const key = normalizeClientName(client.name);
      if (key) clientsByName.set(key, [...(clientsByName.get(key) ?? []), { id: client.id, name: client.name }]);
      continue;
    }
    clientsByRut.set(rut, [...(clientsByRut.get(rut) ?? []), { id: client.id, name: client.name }]);
    rutByClientId.set(client.id, rut);
  }

  // A RUT shared by two clients cannot be resolved without guessing: those
  // rows become errors the user can see (and fix by merging the clients).
  const results: NuboxRowResult[] = validated.map((result) => {
    if (!result.document) return result;
    const matches = clientsByRut.get(result.document.rut) ?? [];
    if (matches.length > 1) {
      return {
        rowNumber: result.rowNumber,
        raw: result.raw,
        document: null,
        error: `Hay ${matches.length} clientes con el RUT ${result.document.rut} (${matches
          .map((match) => match.name)
          .join(", ")}); unificalos antes de importar`,
        skipped: null,
      };
    }
    if (matches.length === 0) {
      const sameName = clientsByName.get(normalizeClientName(result.document.clientName)) ?? [];
      if (sameName.length > 1) {
        return {
          rowNumber: result.rowNumber,
          raw: result.raw,
          document: null,
          error: `Hay ${sameName.length} clientes llamados "${result.document.clientName}" sin RUT; cargale el RUT a uno (o unificalos) antes de importar`,
          skipped: null,
        };
      }
    }
    return result;
  });

  const documents = results.flatMap((result) => (result.document ? [result.document] : []));

  const clientByRut = new Map<string, ClientMatch>();
  const newClientsByRut = new Map<string, string>();
  const clientsToComplete: NuboxAnalysis["clientsToComplete"] = [];
  const claimedByName = new Set<string>();
  for (const document of documents) {
    if (clientByRut.has(document.rut)) continue;

    const byRut = clientsByRut.get(document.rut)?.[0];
    if (byRut) {
      clientByRut.set(document.rut, byRut);
      continue;
    }

    const byName = clientsByName.get(normalizeClientName(document.clientName))?.[0];
    if (byName && !claimedByName.has(byName.id)) {
      claimedByName.add(byName.id);
      clientByRut.set(document.rut, { ...byName, completeRut: true });
      rutByClientId.set(byName.id, document.rut);
      clientsToComplete.push({
        id: byName.id,
        storedName: byName.name,
        fileName: document.clientName,
        rut: document.rut,
      });
      continue;
    }

    clientByRut.set(document.rut, null);
    newClientsByRut.set(document.rut, document.clientName);
  }

  const existing = await getExistingDocumentsByNumber(
    companyId,
    documents.map((document) => document.documentNumber),
  );
  const existingByKey = new Map<string, ExistingDocument>();
  for (const stored of existing) {
    if (stored.documentNumber) {
      existingByKey.set(documentKey(stored.documentType as "invoice", stored.documentNumber), stored);
    }
  }

  const classifications = new Map<number, Classification>();
  for (const document of documents) {
    classifications.set(
      document.rowNumber,
      classifyDocument(document, clientByRut.get(document.rut)?.id ?? null, existingByKey),
    );
  }

  // --- Sales already loaded without a folio ---------------------------
  const clientNameById = new Map(clients.map((client) => [client.id, client.name]));
  const knownClientIds = Array.from(clientByRut.values()).flatMap((match) => (match ? [match.id] : []));
  const dates = documents.map((document) => document.documentDate).sort();
  const legacy =
    dates.length > 0
      ? await getUnnumberedSales(companyId, knownClientIds, dates[0], dates[dates.length - 1])
      : [];

  const { adopted, leftover } = suggestAdoptions(
    documents
      .filter(
        (document) =>
          classifications.get(document.rowNumber)?.kind === "new" &&
          Boolean(clientByRut.get(document.rut)),
      )
      .map((document) => ({
        rowNumber: document.rowNumber,
        documentNumber: document.documentNumber,
        clientId: clientByRut.get(document.rut)!.id,
        documentDate: document.documentDate,
        netAmount: document.netAmount,
      })),
    legacy,
  );
  for (const [rowNumber, stored] of adopted) {
    classifications.set(rowNumber, { kind: "adopt", legacy: stored });
  }

  const leftoverSales: LeftoverSale[] = leftover
    .map((stored) => ({
      clientName: clientNameById.get(stored.clientId) ?? "",
      documentDate: stored.documentDate,
      netAmount: stored.netAmount,
    }))
    .sort((a, b) => b.documentDate.localeCompare(a.documentDate) || a.clientName.localeCompare(b.clientName));

  const summary = summarize(results, classifications);

  // --- Credit notes ---------------------------------------------------
  const clientNameByRut = new Map(documents.map((document) => [document.rut, document.clientName]));
  const fileInvoices = documents.filter((document) => document.documentType === "invoice");
  const fileFolios = new Set(fileInvoices.map((invoice) => invoice.documentNumber));

  const isAnnulled = (document: NuboxDocument) => {
    const stored = existingByKey.get(documentKey(document.documentType, document.documentNumber));
    return Boolean(stored && (stored.voided || stored.annulledByDocumentId));
  };

  const pairingInvoices = new Map<string, PairingInvoice>();
  for (const invoice of fileInvoices) {
    if (isAnnulled(invoice)) continue;
    pairingInvoices.set(invoice.documentNumber, {
      documentNumber: invoice.documentNumber,
      clientKey: invoice.rut,
      netAmount: invoice.netAmount,
      documentDate: invoice.documentDate,
    });
  }

  for (const stored of await getPairableInvoices(companyId, knownClientIds)) {
    const rut = rutByClientId.get(stored.clientId);
    if (!rut || pairingInvoices.has(stored.documentNumber)) continue;
    pairingInvoices.set(stored.documentNumber, {
      documentNumber: stored.documentNumber,
      clientKey: rut,
      netAmount: stored.netAmount,
      documentDate: stored.documentDate,
    });
  }

  const creditNotes = documents.filter((document) => document.documentType === "credit_note");
  const pairableNotes = creditNotes.filter((note) => {
    const stored = existingByKey.get(documentKey("credit_note", note.documentNumber));
    return !stored || (!stored.annulsDocumentId && !stored.voided);
  });

  const suggestions = new Map(
    suggestCreditNotePairs(
      pairableNotes.map((note) => ({
        documentNumber: note.documentNumber,
        clientKey: note.rut,
        netAmount: note.netAmount,
        documentDate: note.documentDate,
      })),
      Array.from(pairingInvoices.values()),
    ).map((suggestion) => [suggestion.creditNoteNumber, suggestion]),
  );

  const creditNoteViews: CreditNoteView[] = creditNotes
    .map((note): CreditNoteView => {
      const base = {
        documentNumber: note.documentNumber,
        clientName: clientNameByRut.get(note.rut) ?? note.clientName,
        documentDate: note.documentDate,
        netAmount: note.netAmount,
      };
      const suggestion = suggestions.get(note.documentNumber);
      if (!suggestion) {
        return { ...base, state: "paired", autoPairedWith: null, candidates: [] };
      }
      const candidates = suggestion.candidates.map((folio) => ({
        documentNumber: folio,
        documentDate: pairingInvoices.get(folio)?.documentDate ?? "",
        inFile: fileFolios.has(folio),
      }));
      if (suggestion.autoPairedWith) {
        return { ...base, state: "auto", autoPairedWith: suggestion.autoPairedWith, candidates: [] };
      }
      return { ...base, state: candidates.length > 0 ? "choose" : "none", autoPairedWith: null, candidates };
    })
    .sort((a, b) => a.documentNumber.localeCompare(b.documentNumber, undefined, { numeric: true }));

  // --- Invoice -> job -------------------------------------------------
  const autoAnnulled = new Set(
    creditNoteViews.flatMap((view) => (view.autoPairedWith ? [view.autoPairedWith] : [])),
  );

  const linkable = fileInvoices.filter((invoice) => {
    if (classifications.get(invoice.rowNumber)?.kind !== "new") return false;
    if (autoAnnulled.has(invoice.documentNumber)) return false;
    return Boolean(clientByRut.get(invoice.rut));
  });

  const jobs = linkable.length > 0 ? await getProjectBillingBalances(companyId) : [];
  const suggestedByFolio = new Map(
    suggestProjectLinks(
      linkable.map((invoice) => ({
        documentNumber: invoice.documentNumber,
        clientId: clientByRut.get(invoice.rut)!.id,
        netAmount: invoice.netAmount,
        documentDate: invoice.documentDate,
      })),
      jobs,
    ).map((suggestion) => [suggestion.documentNumber, suggestion.suggestedProjectId]),
  );

  const invoiceLinks: InvoiceLinkView[] = linkable.map((invoice) => ({
    documentNumber: invoice.documentNumber,
    rowNumber: invoice.rowNumber,
    clientId: clientByRut.get(invoice.rut)!.id,
    clientName: clientNameByRut.get(invoice.rut) ?? invoice.clientName,
    documentDate: invoice.documentDate,
    netAmount: invoice.netAmount,
    suggestedProjectId: suggestedByFolio.get(invoice.documentNumber) ?? null,
  }));

  return {
    results,
    classifications,
    summary,
    clientByRut,
    newClients: Array.from(newClientsByRut, ([rut, name]) => ({ rut, name })),
    clientsToComplete,
    leftoverSales,
    creditNotes: creditNoteViews,
    invoiceLinks,
    jobs,
  };
}
