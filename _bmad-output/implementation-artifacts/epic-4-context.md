# Epic 4 Context: Chile CSV/Excel Importer

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Give Chile-based users a way to bring sales/income data in from CSV/Excel files with column mapping, a pre-commit preview, validation, and duplicate detection — while ensuring the import is never the only way to get data in (manual create/edit from Epic 2 must always remain fully available and equally valid). Every import must be traceable: recorded as a batch with its source file, results, and a link back from each imported record to the row and batch it came from.

## Stories

- Story 4.1: Import Sales with Column Mapping & Preview
- Story 4.2: Duplicate Detection on Import
- Story 4.3: Import Batch History & Traceability

## Requirements & Constraints

- Only Chile uses file import for sales; Uruguay is manual-only. Chile also retains manual entry as a first-class path (per PRD: "never depend solely on the file; every record must be creatable/editable manually with audit trail").
- Column mapping must resolve source columns to the internal fields: date, client, amount, currency, tax.
- Rows with invalid/missing required data (date, amount, client) must be flagged with a specific error and excluded from commit unless fixed or explicitly skipped — nothing invalid silently becomes a saved record.
- Duplicate detection compares external identifier or key fields (date, client, amount) against existing sales documents (manual or previously imported). Duplicates are flagged in the preview with the choice to skip or force-import; a forced duplicate keeps both records with the override noted for audit.
- Revenue must never be double-counted across imports or between manual and imported entries.
- Every import (full or partial) produces a batch record showing file name, date, user, and row counts (imported/error/duplicate).
- Any sales document originating from an import must show, on its detail view, which batch and source row produced it (import provenance is queryable from the record, not just from the batch).
- Amounts must preserve original currency; net sales exclude recoverable tax while the document still retains tax and total (this general financial rule applies to imported sales documents same as manual ones).
- Do not consider an empty/missing cost or amount as zero — use explicit pending/confirmed states rather than defaulting.

## Technical Decisions

- Source of truth is PostgreSQL via Supabase; CSV/Excel is only an input/output interface, never the system of record.
- Data model includes `import_batches` and `import_rows` tables for traceability of source file, errors, and duplicate control. Sales land in the standard `sales_documents` / `sales_lines` tables — imported and manually-entered sales share the same underlying schema, distinguished by origin/source metadata.
- Preserve the source/origin and external identifier of imported documents specifically to support duplicate avoidance.
- RLS applies per company — import operations for Chile must respect company-scoped access control like all other financial entities.
- Record acting user and creation/modification timestamps on import batches and resulting records (standard audit pattern used across the system).
- Corrections must be traceable; avoid silently deleting documents once they're part of an import batch or already reflected in reports.
- Currency/amount handling: preserve original currency and amount on the transaction; any consolidated-currency conversion is derived at report time, never overwrites the original imported values.

## Cross-Story Dependencies

- Depends on Epic 2 (Manual Income Entry) for the underlying `sales_documents`/`sales_lines` model and validation rules that imported rows must map into.
- Depends on Epic 1 (Foundational Setup & Master Data) for company scoping, RLS, and user/audit fields.
- Duplicate detection (4.2) depends on 4.1's mapping/preview existing first, since duplicates are surfaced in that same preview step.
- Batch history and per-record provenance (4.3) depends on both 4.1 (batch creation) and 4.2 (duplicate/override outcomes) to have complete row-level results to display.
- Feeds Epic 6 (Profitability Engine & Reporting): imported sales must be indistinguishable from manual sales for reporting/margin calculations once committed.
