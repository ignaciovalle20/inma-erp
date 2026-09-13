---
title: 'Story 3.4: Prevent Duplicate Cost Counting'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '07f8f8248b95ec00ffb1f75d1d2c9f2b0f79b3e7'
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem (redefined, see below):** A user manually re-entering a cost document (the same supplier invoice keyed in twice, e.g. after a page reload or by two people) silently double-counts it toward margin, with nothing warning them before it happens.

**Original scope was unbuildable, redefined with the human (2026-09-13):** as recorded in `deferred-work.md`, this story's original AC described checking a cost "already tied to a sales line" against a "later-imported supplier document" — but no structural link exists between `cost_documents`/`sales_documents`, and no story anywhere imports supplier/cost documents (Epic 4's importer is sales-only). Raised to the user via AskUserQuestion; given no strong preference between (a) redefining as manual-entry duplicate detection or (b) building a whole new cost-importer story first, the smaller, immediately buildable, real-value option was chosen: **detect a likely duplicate at the moment a cost document is manually created**, using what already exists (Story 3.1's manual entry form) rather than inventing new import infrastructure the PRD never actually specified a shape for.

**Approach:** Before inserting a new cost document, check for an existing one on the same company with the same supplier, document date, and total amount. If found, don't block the save — warn the user with the matching document's details and require an explicit "save anyway" confirmation, mirroring the non-destructive "flag for review, don't auto-reject" principle from the epic's own requirements (and the same UX shape Epic 4's import-time duplicate detection already uses).

## Boundaries & Constraints

**Always:** the duplicate check never blocks saving outright — a real business case (two genuinely separate invoices, same supplier/date/amount by coincidence) must remain possible via one explicit confirmation step; the warning shows enough of the existing document (date, supplier, amount, classification) for the user to make an informed call; both documents remain as independent rows afterward — this story never auto-merges, auto-deletes, or auto-voids either one.

**Decisions (made autonomously, with reasoning):** **match key = (company_id, supplier_id, document_date, total_amount)** — the same four fields a human would glance at to recognize "this looks like the same invoice," and cheap to compare without new schema; a `null` supplier_id never matches another `null` (two undated-supplier costs coincidentally sharing date/amount is not suspicious enough to warn on, since `supplier_id` is optional and often absent for informal costs) — so the check is skipped entirely when the new document has no supplier selected; **no persistent "these two are linked as a resolved duplicate" record is created** — the original AC's linking/traceability mechanism assumed the sales-line/import scenario that doesn't exist in this codebase; recording a real link with no defined consumer would be speculative schema, so this story stops at the warn-and-confirm interaction, which is the concrete, buildable slice of "prevent duplicate cost counting" available today.

**Never:** silently skip or drop a submission that looks like a duplicate (must always surface it to the user, per epic's "flagged for user review, not auto-merged or auto-rejected"); compare across companies (RLS-scoped, and cross-company amounts are never meaningfully "the same invoice"); require the check to pass before allowing classification/allocation to be set — the warning is purely additive to the existing Story 3.1 form flow.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No matching cost document exists | New cost document, unique (supplier, date, amount) combination | Saves immediately, no warning shown | N/A |
| A matching cost document exists, first submission | Same company/supplier/date/total_amount as an existing cost document | Save is NOT performed; form re-renders with a "possible duplicate" warning naming the existing document (date, amount, classification) and a "Save anyway" action | N/A |
| User confirms after seeing the warning | Same form re-submitted with the confirmation flag set | Saves normally, a second (now two) cost document exists, no link/merge between them | N/A |
| New document has no supplier selected | `supplier_id` is null | Duplicate check is skipped entirely (never warns) | N/A |

</frozen-after-approval>

## Code Map

- `web/src/app/companies/[id]/costs/new/actions.ts` -- `createCostDocument` server action: add the duplicate check before the `create_cost_document` RPC call, gated by a new `confirm_duplicate` hidden form field
- `web/src/app/companies/[id]/costs/new/form.tsx` -- render the "possible duplicate" warning (mirroring the visual pattern already used for import's "Possible duplicate" badge) with a "Save anyway" submit button that sets `confirm_duplicate=true`
- `web/src/lib/dal.ts` -- new `findPotentialDuplicateCost(companyId, supplierId, documentDate, totalAmount)` query helper

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/dal.ts` -- `findPotentialDuplicateCost` -- selects one existing `cost_documents` row matching `(company_id, supplier_id, document_date, total_amount)`, returns `null` when `supplierId` is null or no match
- [x] `web/src/app/companies/[id]/costs/new/actions.ts` -- call the check before the RPC; if a match is found and `confirm_duplicate !== "true"`, return a new `duplicateWarning` state field (not a blocking `error`) instead of inserting
- [x] `web/src/app/companies/[id]/costs/new/form.tsx` -- render the warning box + "Save anyway" button (submits with `confirm_duplicate=true`) when `duplicateWarning` is present

**Acceptance Criteria:**
- Given an existing cost document with the same company/supplier/date/total amount, when a user submits a new cost document matching all four, then the save is held and a duplicate warning is shown instead of silently creating a second entry
- Given the warning is shown, when the user explicitly confirms, then the document saves normally
- Given the new document has no supplier selected, then no duplicate check/warning ever occurs

## Implementation Notes

**Verified live against the linked Supabase project and the running app (browser)**:
- Creating a cost document matching an existing one's (supplier, date, total amount) held the save and rendered the "Possible duplicate" warning naming the existing document's date/amount/currency/classification, exactly as specced.
- Clicking "Save anyway" (which resubmits with `confirm_duplicate=true`) created the second document successfully -- confirmed both rows now exist independently in `cost_documents`, no merge/link.
- Submitting two cost documents with no supplier selected, same date/amount, twice in a row -- neither triggered the warning, confirming the "skip when supplier is null" rule.
- All three browser-test documents created during verification were deleted afterward (not real business data, unlike Story 6.7's historical load) -- confirmed the January 2026 reconciliation totals from Story 6.7 (CLP 3,271,396 / USD 7) were unaffected before and after.
- `npx tsc --noEmit` and `npm run build` both pass clean.

**Pre-existing bug found and fixed as part of this story (not deferred):** the Supplier `<select>` used `defaultValue`, the same root cause already logged in `deferred-work.md` for the project/business-area pickers on Story 1.6's form (recurring in Story 2.1's `document_type` select) -- it doesn't reliably re-apply on a re-render after a server action returns. Here it meant the supplier field visually reset to "No supplier" right when the duplicate warning appeared -- exactly the moment a user clicks "Save anyway," which would have silently saved the confirmed document with the wrong (empty) supplier. Since this bug directly undermines this story's own confirm-and-save flow (not just a cosmetic papercut), it was fixed here rather than deferred again: the supplier field is now a controlled `<select>` (`useState` + `value`/`onChange`), matching the pattern already used for `classification`/`projectId` on this same form, which don't reset because React preserves controlled-component state across re-renders of the same DOM node. Verified: after the duplicate warning appears, the selected supplier now stays selected, and "Save anyway" saves with the correct supplier.

## Spec Change Log

## Review Triage Log

## Design Notes

Full traceable duplicate-resolution linking (per the original epic wording) is out of scope here — see Decisions. If a real cost-importer story is ever built, that story should revisit whether this warn-and-confirm mechanism needs to grow into a persisted link.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit`
- `cd web && npm run build`

**Manual checks:**
- Create a cost document, then attempt to create another with the same supplier/date/total amount -- confirm the warning appears and the second save is held
- Click "Save anyway" -- confirm both documents now exist independently
- Create a cost document with no supplier selected, twice, with the same date/amount -- confirm no warning appears either time
