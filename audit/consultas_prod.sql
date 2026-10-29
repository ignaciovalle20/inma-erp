-- =============================================================================
-- audit/consultas_prod.sql -- Consultas de solo lectura usadas en la auditoría
-- 2026-10 (resultados en audit/INFORME_AUDITORIA.md §3).
--
-- Se corrieron el 2026-10-28 contra prod (jxkfpkgyvjiyufmfxsfp) dentro de
-- "begin transaction read only; ...; commit", con:
--   supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp "<sql>"
-- Cada bloque devuelve (k, n): el código del chequeo y la cantidad de filas
-- que lo violan. Los detalles (qué filas) están en el informe.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Bloque 1: montos, monedas, duplicados, proyectos, importaciones
-- ---------------------------------------------------------------------------
with co as (select id, country, currency from companies)
select 'D01 companies currency incoherent with country' k, count(*) n from co where (country in ('CL','Chile') and currency<>'CLP') or (country in ('UY','Uruguay') and currency not in ('USD','UYU'))
union all select 'D01b companies without country', count(*) from co where country is null
union all select 'D02 sales docs currency not local/USD', count(*) from sales_documents s join co on co.id=s.company_id where s.currency not in (co.currency,'USD')
union all select 'D03 cost docs currency not local/USD', count(*) from cost_documents c join co on co.id=c.company_id where c.currency not in (co.currency,'USD')
union all select 'D04 sales net+tax+other<>total', count(*) from sales_documents where abs(net_amount+tax_amount+other_taxes-total_amount)>case when currency='CLP' then 1 else 0.01 end
union all select 'D05 cost net+tax+other<>total (net incluye exento)', count(*) from cost_documents where abs(net_amount+tax_amount+other_taxes-total_amount)>case when currency='CLP' then 1 else 0.01 end
union all select 'D06 CLP sales with decimals', count(*) from sales_documents where currency='CLP' and (net_amount<>round(net_amount) or total_amount<>round(total_amount) or tax_amount<>round(tax_amount))
union all select 'D07 CLP cost with decimals', count(*) from cost_documents where currency='CLP' and (net_amount<>round(net_amount) or total_amount<>round(total_amount) or tax_amount<>round(tax_amount))
union all select 'D08 sales credit_note stored positive (convención)', count(*) from sales_documents where document_type='credit_note' and net_amount>0
union all select 'D09 sales non-credit-note negative', count(*) from sales_documents where document_type<>'credit_note' and net_amount<0
union all select 'D10 dup sales same company/type/number', count(*) from (select 1 from sales_documents where document_number is not null group by company_id, document_type, document_number having count(*)>1) x
union all select 'D11 dup sales w/o number same co/client/date/total/type', count(*) from (select 1 from sales_documents where document_number is null and not voided group by company_id, client_id, document_date, total_amount, document_type, currency having count(*)>1) x
union all select 'D12 dup cost docs same co/supplier/type/number', count(*) from (select 1 from cost_documents where document_number is not null group by company_id, supplier_id, source_document_type, document_number having count(*)>1) x
union all select 'D13 dup cost docs w/o number same co/supplier/date/total', count(*) from (select 1 from cost_documents where document_number is null group by company_id, supplier_id, document_date, total_amount, currency having count(*)>1) x
union all select 'D14 sales duplicate_override', count(*) from sales_documents where duplicate_override
union all select 'D15 cost duplicate_override', count(*) from cost_documents where duplicate_override
union all select 'D16 projects active w/o quote', count(*) from projects p where p.status not in ('por_cotizar','cancelado') and not exists (select 1 from project_quotes q where q.project_id=p.id)
union all select 'D17 projects por_cotizar w/o quote (permitido)', count(*) from projects p where p.status='por_cotizar' and not exists (select 1 from project_quotes q where q.project_id=p.id)
union all select 'D18 quote company <> project company', count(*) from project_quotes q join projects p on p.id=q.project_id where q.company_id<>p.company_id
union all select 'D19 sales foreign ccy w/o exchange_rate', count(*) from sales_documents s join co on co.id=s.company_id where s.currency<>co.currency and s.exchange_rate is null and not s.voided
union all select 'D20 cost foreign ccy w/o exchange_rate', count(*) from cost_documents c join co on co.id=c.company_id where c.currency<>co.currency and c.exchange_rate is null
union all select 'D21 import_rows imported w/o sales doc', count(*) from import_rows where status='imported' and sales_document_id is null
union all select 'D22 cost_import_rows imported w/o cost doc', count(*) from cost_import_rows where status='imported' and cost_document_id is null and deleted_at is null
union all select 'D23 sales import_row company mismatch', count(*) from sales_documents s join import_rows r on r.id=s.import_row_id join import_batches b on b.id=r.import_batch_id where b.company_id<>s.company_id
union all select 'D24 cost import_row points elsewhere', count(*) from cost_documents c join cost_import_rows r on r.id=c.import_row_id where r.cost_document_id is distinct from c.id
union all select 'D25 sales docs w/o lines', count(*) from sales_documents s where not exists (select 1 from sales_lines l where l.sales_document_id=s.id)
union all select 'D26 cost docs w/o lines', count(*) from cost_documents c where not exists (select 1 from cost_lines l where l.cost_document_id=c.id)
union all select 'D27 cost N/C stored as positive invoice', count(*) from cost_documents where source_document_type like 'N/C%' and (document_type<>'credit_note' or net_amount>0);

-- ---------------------------------------------------------------------------
-- Bloque 2: recurrentes, asignaciones, técnicos, tipo de cambio, MCP, maestros
-- ---------------------------------------------------------------------------
select 'R01 active services w/o any occurrence' k, count(*) n from recurring_services rs where rs.status='active' and not exists (select 1 from recurring_service_occurrences o where o.recurring_service_id=rs.id)
union all select 'R02 active monthly services missing past month (desde 2026-01)', count(*) from recurring_services rs cross join lateral generate_series(greatest(date_trunc('month', rs.start_date), '2026-01-01'::timestamptz), date_trunc('month', current_date) - interval '1 month', interval '1 month') g(m) where rs.status='active' and rs.periodicity='monthly' and (rs.end_date is null or rs.end_date >= g.m) and not exists (select 1 from recurring_service_occurrences o where o.recurring_service_id=rs.id and o.period=g.m::date)
union all select 'R03 periods invoiced/collected w/o invoice nor allocation', count(*) from recurring_service_occurrences o where o.status in ('invoiced','pending_collection','collected') and o.sales_document_id is null and not exists (select 1 from sales_allocations a where a.recurring_service_period_id=o.id)
union all select 'R04 periods pending_invoice > 3 months (active svc)', count(*) from recurring_service_occurrences o join recurring_services rs on rs.id=o.recurring_service_id where o.status='pending_invoice' and o.period < date_trunc('month', current_date) - interval '3 month' and rs.status='active'
union all select 'R05 occurrence currency <> service currency', count(*) from recurring_service_occurrences o join recurring_services rs on rs.id=o.recurring_service_id where o.currency<>rs.currency
union all select 'R06 occurrence linked to voided sales doc', count(*) from recurring_service_occurrences o join sales_documents s on s.id=o.sales_document_id where s.voided
union all select 'R07 sales_allocations sum > doc net', count(*) from (select a.sales_document_id from sales_allocations a join sales_documents s on s.id=a.sales_document_id group by a.sales_document_id, s.net_amount having sum(a.amount) > abs(s.net_amount)+1) x
union all select 'R08 sales_allocations on voided docs', count(*) from sales_allocations a join sales_documents s on s.id=a.sales_document_id where s.voided
union all select 'R09 cost_service_allocations sum > doc net', count(*) from (select a.cost_document_id from cost_service_allocations a join cost_documents c on c.id=a.cost_document_id group by a.cost_document_id, c.net_amount having sum(a.amount) > abs(c.net_amount)+1) x
union all select 'R10 cost pool allocated <> pool total', count(*) from (select p.id from recurring_service_cost_pools p join recurring_service_cost_allocations a on a.cost_pool_id=p.id group by p.id, p.total_expense_amount having abs(sum(a.allocated_amount)-p.total_expense_amount) > 0.01) x
union all select 'R11 cost pool negative allocation', count(*) from recurring_service_cost_allocations where allocated_amount<0
union all select 'R12 cost pool allocated to void occurrence', count(*) from recurring_service_cost_allocations a join recurring_service_occurrences o on o.id=a.occurrence_id where o.status='void'
union all select 'C01 cost_allocations percentage docs sum<>100', count(*) from (select cost_document_id from cost_allocations where method='percentage' group by 1 having abs(sum(percentage)-100)>0.01) x
union all select 'C02 cost_allocations fixed docs sum<>TOTAL (la regla es sobre total)', count(*) from (select a.cost_document_id from cost_allocations a join cost_documents c on c.id=a.cost_document_id where a.method='fixed_amount' group by a.cost_document_id, c.total_amount having abs(sum(a.amount)-c.total_amount)>1) x
union all select 'C04 general cost docs w/o any allocation (informativo)', count(*) from cost_documents c where c.classification='general' and not exists (select 1 from cost_allocations a where a.cost_document_id=c.id) and not exists (select 1 from cost_service_allocations s where s.cost_document_id=c.id) and not exists (select 1 from technician_charges t where t.cost_document_id=c.id) and not exists (select 1 from technician_charge_documents t where t.cost_document_id=c.id)
union all select 'T01 tech charges overpaid', count(*) from (select c.id from technician_charges c join technician_payment_applications a on a.charge_id=c.id group by c.id, c.amount having sum(a.amount) > c.amount + 0.5) x
union all select 'T02 tech payment <> sum of applications', count(*) from (select p.id from technician_payments p left join technician_payment_applications a on a.payment_id=p.id group by p.id, p.amount having abs(coalesce(sum(a.amount),0)-p.amount) > 0.5) x
union all select 'T03 charge recibida w/o linked doc', count(*) from technician_charges c where c.document_status='recibida' and not exists (select 1 from technician_charge_documents d where d.charge_id=c.id)
union all select 'T04 charge linked but pendiente', count(*) from technician_charges c where c.document_status='pendiente' and exists (select 1 from technician_charge_documents d where d.charge_id=c.id)
union all select 'T05 charge cost doc net <> charge net', count(*) from technician_charges c join cost_documents d on d.id=c.cost_document_id where abs(d.net_amount - c.net_amount) > 0.5
union all select 'T06 charge company <> project company', count(*) from technician_charges c join projects p on p.id=c.project_id where p.company_id<>c.company_id
union all select 'T07 charge without backing (legacy)', count(*) from technician_charges where backing is null
union all select 'T08 boleta w/o withholding rate', count(*) from technician_charges where backing='boleta' and withholding_rate is null
union all select 'T09 payment technician <> charge technician', count(*) from technician_payment_applications a join technician_payments p on p.id=a.payment_id join technician_charges c on c.id=a.charge_id where p.personnel_id<>c.personnel_id
union all select 'T10 linked docs cost_amount > doc net', count(*) from (select d.cost_document_id from technician_charge_documents d join cost_documents c on c.id=d.cost_document_id group by d.cost_document_id, c.net_amount having sum(d.cost_amount) > abs(c.net_amount)+1) x
union all select 'X01 FX snapshot months missing CLP/UYU since 2025-01', count(*) from (select c.cur, g.m from (values ('CLP'),('UYU')) c(cur) cross join generate_series('2025-01-01'::timestamptz, date_trunc('month', current_date), interval '1 month') g(m)) x where not exists (select 1 from exchange_rate_snapshots e where e.currency=x.cur and e.period=x.m::date)
union all select 'M01 mcp tokens active', count(*) from mcp_access_tokens where revoked_at is null
union all select 'M02 mcp tokens active unused > 30d', count(*) from mcp_access_tokens where revoked_at is null and coalesce(last_used_at, created_at) < now() - interval '30 days'
union all select 'M03 mcp drafts expired not consumed', count(*) from mcp_pending_drafts where consumed_at is null and expires_at < now()
union all select 'U01 clients dup normalized tax_id', count(*) from (select company_id, normalize_tax_id(tax_id) from clients where tax_id is not null and btrim(tax_id)<>'' group by 1,2 having count(*)>1) x
union all select 'U02 clients dup name', count(*) from (select company_id, lower(btrim(name)) from clients group by 1,2 having count(*)>1) x
union all select 'U03 suppliers dup normalized tax_id', count(*) from (select company_id, normalize_tax_id(tax_id) from suppliers where tax_id is not null and btrim(tax_id)<>'' group by 1,2 having count(*)>1) x
union all select 'P01 finished invoiceable projects w/o any sale', count(*) from projects p where p.status in ('finalizado','cerrado') and p.invoiceable and not exists (select 1 from sales_documents s where s.project_id=p.id and not s.voided) and not exists (select 1 from sales_allocations a join project_quotes q on q.id=a.project_quote_id where q.project_id=p.id)
union all select 'P02 sales doc project company mismatch', count(*) from sales_documents s join projects p on p.id=s.project_id where p.company_id<>s.company_id
union all select 'P03 sales doc client <> project client', count(*) from sales_documents s join projects p on p.id=s.project_id where p.client_id<>s.client_id
union all select 'P04 projects negative quoted/cost budget', count(*) from projects where quoted_amount<0 or cost_budget<0;

-- ---------------------------------------------------------------------------
-- Bloque 3: cobro, notas de crédito, fechas, esquemas de backup
-- ---------------------------------------------------------------------------
select 'S01 sales impago with paid_at' k, count(*) n from sales_documents where payment_status='impago' and paid_at is not null
union all select 'S02 sales pagado w/o paid_at (Nubox no trae fecha)', count(*) from sales_documents where payment_status='pagado' and paid_at is null and document_type<>'credit_note'
union all select 'S03 occurrence linked to other client invoice', count(*) from recurring_service_occurrences o join recurring_services rs on rs.id=o.recurring_service_id join sales_documents s on s.id=o.sales_document_id where s.client_id<>rs.client_id
union all select 'S04 sales_allocation to other client period', count(*) from sales_allocations a join sales_documents s on s.id=a.sales_document_id join recurring_service_occurrences o on o.id=a.recurring_service_period_id join recurring_services rs on rs.id=o.recurring_service_id where rs.client_id<>s.client_id
union all select 'S05 sales_allocation to other company quote', count(*) from sales_allocations a join project_quotes q on q.id=a.project_quote_id where q.company_id<>a.company_id
union all select 'S06 paired credit note net differs from invoice', count(*) from sales_documents n join sales_documents i on i.id=n.annuls_document_id where n.document_type='credit_note' and abs(n.net_amount)<>abs(i.net_amount)
union all select 'S07 annul link not symmetric', count(*) from sales_documents n join sales_documents i on i.id=n.annuls_document_id where i.annulled_by_document_id is distinct from n.id
union all select 'S08 sales doc in future', count(*) from sales_documents where document_date > current_date + 1
union all select 'S09 cost doc in future', count(*) from cost_documents where document_date > current_date + 1
union all select 'S13 personnel_costs negative', count(*) from personnel_costs where amount<0
union all select 'S14 work_allocations exceeding personnel cost', count(*) from (select w.personnel_cost_id from work_allocations w join personnel_costs pc on pc.id=w.personnel_cost_id group by 1, pc.amount having sum(w.amount) > pc.amount + 0.5) x
union all select 'S15 periods invoiced+ w/o invoiced_at', count(*) from recurring_service_occurrences where status in ('invoiced','pending_collection','collected') and invoiced_at is null
union all select 'S16 backup schema tables', count(*) from pg_tables where schemaname like 'backup_%'
union all select 'S17 backup tables readable by anon/authenticated', count(*) from pg_tables t where t.schemaname like 'backup_%' and (has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename), 'select') or has_table_privilege('authenticated', format('%I.%I', t.schemaname, t.tablename), 'select'));

-- ---------------------------------------------------------------------------
-- Bloque 4: huella de esquema (se corre igual en dev y prod y se comparan los md5)
-- ---------------------------------------------------------------------------
select 'columns' k, md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), '|' order by table_name, column_name)) h, count(*) n from information_schema.columns where table_schema='public'
union all select 'constraints', md5(string_agg(conrelid::regclass||':'||conname||':'||pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname)), count(*) from pg_constraint where connamespace='public'::regnamespace
union all select 'indexes', md5(string_agg(indexname||':'||indexdef, '|' order by indexname)), count(*) from pg_indexes where schemaname='public'
union all select 'policies', md5(string_agg(tablename||':'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'')||':'||array_to_string(roles,','), '|' order by tablename, policyname)), count(*) from pg_policies where schemaname='public'
union all select 'functions', md5(string_agg(p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||md5(replace(p.prosrc, chr(13), ''))||':'||p.prosecdef, '|' order by p.proname, pg_get_function_identity_arguments(p.oid))), count(*) from pg_proc p where p.pronamespace='public'::regnamespace
union all select 'triggers', md5(string_agg(tgrelid::regclass||':'||tgname||':'||pg_get_triggerdef(oid), '|' order by tgrelid::regclass::text, tgname)), count(*) from pg_trigger where not tgisinternal and tgrelid::regclass::text not like '%.%'
union all select 'grants', md5(string_agg(table_name||':'||grantee||':'||privilege_type, '|' order by table_name, grantee, privilege_type)), count(*) from information_schema.role_table_grants where table_schema='public'
union all select 'fn_grants', md5(string_agg(routine_name||':'||grantee, '|' order by routine_name, grantee)), count(*) from information_schema.role_routine_grants where routine_schema='public';
