---
title: 'Improve Sales Filter Clarity'
type: 'feature'
created: '2026-09-21'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The sales filters use ambiguous placeholder labels such as “Todo cobro” and “Toda recurrencia,” making the controls difficult to scan and understand.

**Approach:** Present every sales filter with a clear field label and a neutral “All” state, while retaining the current filter parameters, results, filter chips, exports, and period navigation.

</frozen-after-approval>

## Implementation Notes

- The change is UI-only and has no external side effects or data migration.
- Update the sales page’s filter form to use explicit, compact labels and consistent wording. Keep the current query-string values and filtering behavior unchanged.
- Added labels for period, client, project, area, payment status, and document origin. Replaced the ambiguous select defaults with “Todos”; renamed the recurring filter to “Origen”; and clarified the voided-document checkbox.
- Moved the optional Combobox id from its hidden form-value input to the visible text control so the new filter labels focus and name the interactive field correctly.
- `npx tsc --noEmit` passes. `npm run lint` passes with seven existing warnings outside the files changed here.
- `npm run build` reached the production compile but cannot finish in this environment because `next/font` cannot download the existing Archivo and JetBrains Mono Google Fonts.

## Review Triage Log

- medium, patched — The new Client, Project, and Area labels initially targeted hidden Combobox inputs rather than the visible text fields. The Combobox now assigns its optional id to the visible input, restoring label click-to-focus and accessible naming without changing submitted form values.
