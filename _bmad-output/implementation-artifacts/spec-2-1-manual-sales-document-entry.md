---
title: 'Story 2.1: Manual Sales Document Entry'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '6bffc12860890bd3431c500c9e8bee95a7443f42'
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No income/sales entity exists yet. Profitability calculations need sales documents with net/tax/total computed correctly and original currency preserved.

**Approach:** Company-scoped `sales_documents` (header) + `sales_lines` (detail). One `create_sales_document` RPC inserts both atomically, computing `net_amount`/`total_amount` server-side — never trusting client-submitted totals. Any member creates documents (like clients/suppliers). No edit/void yet (Story 2.2).

## Boundaries & Constraints

**Always:** `net_amount`/`total_amount` are always computed server-side from lines + `tax_amount`, never accepted as raw client input; a document needs at least one line to save; original `currency` is stored exactly as entered, never converted; `client_id` must belong to the same `company_id` (reuse the pattern from Story 1.6's cross-company validation — a DB trigger, not just an app check, given that story's own review found the app-only version bypassable).

**Never:** build edit/void (Story 2.2); build the Chile CSV importer (Epic 4); merge sales into a shared table with future cost/payment entities; let the client submit `net_amount`/`total_amount` directly.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create, single line | Valid client, one line with an amount | Document + 1 line saved; `net_amount` = line amount | N/A |
| Create, multiple lines | 2+ lines added client-side before submit | Document saved; `net_amount` = sum of all lines | N/A |
| Create, no lines | Zero lines | Blocked | Validation error, no insert |
| Create, tax provided | `tax_amount` > 0 | `total_amount` = `net_amount` + `tax_amount`, both stored | N/A |
| Client from a different company | Tampered/mismatched `client_id` | Rejected at the DB level | Trigger raises exception, not a silent wrong-company write |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912190000_epic1_story6_manage_projects.sql`, `.../20260912200000_..._review_patches.sql` -- `BEFORE INSERT` cross-company-validation trigger pattern to reuse for `client_id` (one FK here, not two)
- `supabase/migrations/20260912130000_epic1_story2_manage_companies.sql` -- `create_company`'s atomic-multi-insert RPC pattern (not `security definer` here — no bootstrap problem, caller already has RLS-authorized INSERT rights)
- `web/src/lib/dal.ts` -- `getClients` for the picker; any-member check pattern from `getClients`/`getSuppliers`
- `web/src/app/companies/[id]/clients/new/` -- create-only page+action+form template (simpler than clients' flow, no duplicate-warning UX needed)
- No test framework — verify via `npm run dev` + browser + `supabase db query --linked`

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql` -- `sales_documents` (`id`, `company_id`, `client_id` references `clients`, `document_type text check (in ('invoice','receipt','credit_note','manual'))`, `document_date date not null`, `currency text not null`, `net_amount numeric not null default 0`, `tax_amount numeric not null default 0`, `total_amount numeric not null default 0`, audit cols) and `sales_lines` (`id`, `sales_document_id` references `sales_documents`, `description text`, `amount numeric not null`); RLS any-member SELECT/INSERT (no UPDATE/DELETE yet — nothing to edit until Story 2.2); a `BEFORE INSERT` trigger on `sales_documents` validating `client_id`'s `company_id` matches; `create_sales_document(p_company_id, p_client_id, p_document_type, p_document_date, p_currency, p_tax_amount, p_lines jsonb)` computing and inserting document + lines atomically
- [x] `supabase/migrations/20260912220000_epic2_story1_review_patches.sql` -- reject negative tax and zero/negative line amounts inside `create_sales_document`; add a `currency` check constraint matching `companies` (post-review)
- [x] `web/src/lib/dal.ts` -- `getSalesDocuments(companyId)` for the list
- [x] `web/src/app/companies/[id]/sales/page.tsx` -- list (client, date, currency, net/tax/total), "New sales document" link
- [x] `web/src/app/companies/[id]/sales/new/page.tsx` + `actions.ts` + `form.tsx` -- dynamic add/remove line rows client-side; client picker (active clients); currency defaults to the company's base currency; calls `create_sales_document` via RPC; client-side rejection of zero/negative line amounts (post-review)
- [x] `web/src/app/companies/page.tsx` -- add a "Sales" link

**Acceptance Criteria:**
- Given I add 2+ lines and a tax amount, when I submit, then `net_amount` = sum of lines and `total_amount` = net + tax, both computed server-side — ✅ verified live via RPC: 2-line document (1000+500) + tax 190 → net=1500, tax=190, total=1690
- Given I submit with zero lines, then it's blocked with a validation error, not a DB error — ✅ verified: `p_lines: []` rejected with a clear exception
- Given a tampered `client_id` from a different company is submitted, then the DB trigger rejects it — ✅ verified live as `test-chile` with a real Uruguay client id, both via raw insert and via the RPC — both rejected (`P0001`)
- Given I save a document, then it's stored in `sales_documents`/`sales_lines`, structurally separate from any cost/payment table — ✅ verified: no cost/payment table exists yet, schema confirmed separate

## Implementation Notes

- **Live-verified reuse of Story 1.6's fix**: the cross-company `client_id` validation trigger was built in from the start this time (per this spec's explicit instruction), not discovered as a gap after the fact. Verified live as an authenticated `test-chile` session against a real Uruguay client id — rejected identically via both the raw REST insert and the `create_sales_document` RPC.
- Code review found 3 real gaps, all fixed in a follow-up migration: negative tax accepted, zero/negative line amounts accepted, and no currency check constraint (inconsistent with `companies`). Re-verified live after the fix: negative tax rejected, zero-amount line rejected, invalid currency rejected by the new constraint, and a valid document still succeeds correctly (net/tax/total computed right).
- Known minor gap, deferred (same root cause already logged from Story 1.6): the `document_type` `<select>` doesn't preserve its value correctly on a validation-error redisplay.
- All test data (temporary clients, sales documents/lines) created during verification was deleted afterward via `supabase db query --linked`.

## Spec Change Log

## Review Triage Log

- **verdict: medium** — `create_sales_document` accepts `p_tax_amount` with only `coalesce(..., 0)`, no non-negative check — a negative tax via a direct RPC call (bypassing the app's own check) produces `total_amount < net_amount`, silently corrupting stored totals. → **patch**: reject `p_tax_amount < 0` inside the function.
- **verdict: low** — no check that a line's `amount` is non-zero; a zero-amount line is silently accepted and contributes nothing to the total. → **patch**: reject zero (and negative, to be consistent) line amounts inside the function.
- **verdict: low** — `sales_documents.currency` has no check constraint, unlike `companies.currency` (`CLP`/`UYU`/`USD`); any string is currently accepted. → **patch**: add the same check constraint for consistency.
- **false (misunderstands non-`security definer` semantics)** — claim that `create_sales_document` lacks "defense in depth" against RLS being dropped, since it doesn't independently re-check membership. Disproven: the function is deliberately *not* `security definer` (per the spec's own Design Notes), so it runs with the caller's own privileges — every insert inside it is subject to the exact same RLS policies as a direct client insert. There is no separate protection layer to lose; if RLS were ever dropped, direct client access would be equally exposed, which is a different (and already covered) concern, not something unique to this function.
- **reject (by design, not a bug)** — the UI's live "Net total" preview excludes tax. Correct: net and tax are deliberately separate figures per the PRD's own financial model (net ≠ total); showing them combined in the running total would misrepresent what's being computed.
- **reject (consistent with established precedent)** — generic "Something went wrong" error hides the specific validation reason. Same pattern already accepted everywhere else in this codebase (server-side `console.error` for diagnosis, generic user-facing message).
- **reject (out of scope)** — no per-document detail/drill-down view of line items after creation. Not in this story's Tasks & Acceptance; the list view showing header totals is what was scoped, matching Epic 6's later drill-down story as the actual place this belongs.
- **reject (YAGNI, consistent with precedent)** — no pagination on the sales list, and no cap on the number of lines per document. Same reasoning already applied to every other list in this app (2-person internal tool, no current scale need).
- **reject (no precedent elsewhere either)** — a client deactivated between page load and submit could still be used (TOCTOU). No other create flow in this app (companies, projects) re-validates "active" status server-side either — only cross-company scoping is enforced that strictly, and that's the actual security boundary, not staleness of the `active` flag.
- **defer (same root cause as an existing entry)** — the `document_type` `<select>` doesn't preserve an invalid/defaulted value correctly on a validation-error redisplay. Same underlying React `defaultValue`-on-`<select>` limitation already logged in `deferred-work.md` from Story 1.6 — noted there as recurring, no new entry needed.
- **defer (already covered)** — no automated tests for the new RPC's validation branches. Same root condition as the existing "add a test framework" entry.

## Design Notes

`create_sales_document` is a plain function (not `security definer`) — no bootstrap problem here; the caller already has RLS-authorized INSERT rights on both tables, so the function just buys transactional atomicity.

Tax is a plain user-entered amount, not computed from a jurisdiction rate — Chile/Uruguay likely differ and no rate-config story exists yet. `total_amount` is still always derived (`net + tax`), never entered directly.

No status/void column yet — Story 2.2 adds that alongside edit capability (only what the current story needs).

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- As `test-chile`: create a document with 2 lines + tax, confirm net/total computed correctly and both lines saved
- Try submitting with zero lines — confirm a validation error, not a crash
- Attempt the same cross-company `client_id` bypass technique used in Story 1.6's review (raw API call) — confirm the DB trigger rejects it
