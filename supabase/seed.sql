-- Minimal test data for the DEV Supabase project. All of it is invented:
-- no real clients, suppliers, tax IDs or amounts.
--
--   supabase db push --include-seed        (only ever against the DEV project)
--
-- Idempotent: every row has a fixed id and `on conflict do nothing`, so it can
-- be applied again without duplicating anything.
--
-- It creates NO auth users and stores NO passwords. Accounts are provisioned
-- from the Supabase Dashboard (see the note in
-- 20260912120000_epic1_story1_auth_foundation.sql); the last block gives every
-- user that already exists admin access to the two demo companies. See
-- README.md, section "Entornos".

-- ---------------------------------------------------------------------
-- Guard: refuse to run on a database that holds real data.
-- Production has companies that are not the two below, so this aborts there.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from public.companies
    where id not in (
      'a0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000002'
    )
  ) then
    raise exception
      'seed.sql aborted: this database has companies that are not demo data (is it production?)';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Companies (Chile in CLP, Uruguay in UYU). The trigger from Story 1.5
-- adds the 9 default business areas to each one on insert.
-- ---------------------------------------------------------------------
insert into public.companies (id, name, country, tax_id, currency, management_start_date)
values
  ('a0000000-0000-4000-8000-000000000001', 'Demo Chile SpA',     'CL', '99.999.999-9',   'CLP', date '2026-01-01'),
  ('a0000000-0000-4000-8000-000000000002', 'Demo Uruguay SRL',   'UY', '210000000000',   'UYU', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Clients and suppliers (one of each per company; they are company-scoped)
-- ---------------------------------------------------------------------
insert into public.clients (id, company_id, name, tax_id, country, notes)
values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Cliente Demo Chile', '11.111.111-1', 'CL', 'Test data'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
   'Cliente Demo Uruguay', '210000000001', 'UY', 'Test data')
on conflict (id) do nothing;

insert into public.suppliers (id, company_id, name, tax_id, country, notes)
values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Proveedor Demo Chile', '22.222.222-2', 'CL', 'Test data'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
   'Proveedor Demo Uruguay', '210000000002', 'UY', 'Test data')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Jobs ("trabajos") and their quote numbers. Business areas are looked up
-- by name because the trigger above gives them random ids.
-- ---------------------------------------------------------------------
insert into public.projects (
  id, company_id, client_id, business_area_id, name,
  start_date, end_date, status, budget, responsible
)
values
  ('d0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000001' and name = 'Networking'),
   'Demo - Red de oficina', date '2026-08-01', null, 'en_ejecucion', 2500000, 'Tecnico Demo'),
  ('d0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000001' and name = 'IT Support'),
   'Demo - Servidor de archivos', date '2026-08-15', date '2026-09-10', 'finalizado', 800000, 'Tecnico Demo'),
  ('d0000000-0000-4000-8000-000000000003',
   'a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000002' and name = 'Security/CCTV'),
   'Demo - Camaras de seguridad', date '2026-08-05', null, 'en_ejecucion', 150000, 'Tecnico Demo')
on conflict (id) do nothing;

insert into public.project_quotes (id, project_id, company_id, quote_number)
values
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'DEV-1001'),
  ('d1000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000001', 'DEV-1002'),
  ('d1000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003',
   'a0000000-0000-4000-8000-000000000002', 'DEV-2001')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Income (sales documents + one line each; line amount = net amount).
-- CLP and USD for Chile, UYU and USD for Uruguay. Mixed payment states.
-- ---------------------------------------------------------------------
insert into public.sales_documents (
  id, company_id, client_id, project_id, business_area_id, document_type,
  document_number, document_date, currency, net_amount, tax_amount, total_amount,
  due_date, payment_status, paid_at, payment_method
)
values
  -- Chile, CLP, paid
  ('e0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000001' and name = 'Networking'),
   'invoice', 'DEV-F-1001', date '2026-08-05', 'CLP', 1000000, 190000, 1190000,
   date '2026-09-04', 'pagado', date '2026-08-25', 'transferencia'),
  -- Chile, CLP, overdue
  ('e0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000001' and name = 'Networking'),
   'invoice', 'DEV-F-1002', date '2026-08-20', 'CLP', 500000, 95000, 595000,
   date '2026-09-19', 'vencido', null, null),
  -- Chile, USD (no IVA), not yet due
  ('e0000000-0000-4000-8000-000000000003',
   'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000001' and name = 'IT Support'),
   'invoice', 'DEV-F-1003', date '2026-09-02', 'USD', 1200, 0, 1200,
   date '2026-10-02', 'por_vencer', null, null),
  -- Chile, CLP, manual sale without a job (general income)
  ('e0000000-0000-4000-8000-000000000004',
   'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   null,
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000001' and name = 'Hosting'),
   'manual', null, date '2026-09-10', 'CLP', 250000, 47500, 297500,
   null, null, null, null),
  -- Uruguay, UYU, paid
  ('e0000000-0000-4000-8000-000000000005',
   'a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   'd0000000-0000-4000-8000-000000000003',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000002' and name = 'Security/CCTV'),
   'invoice', 'DEV-UY-2001', date '2026-08-10', 'UYU', 100000, 22000, 122000,
   date '2026-09-09', 'pagado', date '2026-09-01', 'transferencia'),
  -- Uruguay, USD, paid
  ('e0000000-0000-4000-8000-000000000006',
   'a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   'd0000000-0000-4000-8000-000000000003',
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000002' and name = 'Security/CCTV'),
   'receipt', 'DEV-UY-2002', date '2026-09-05', 'USD', 500, 0, 500,
   null, 'pagado', date '2026-09-05', 'efectivo'),
  -- Uruguay, UYU, manual sale without a job
  ('e0000000-0000-4000-8000-000000000007',
   'a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   null,
   (select id from public.business_areas
     where company_id = 'a0000000-0000-4000-8000-000000000002' and name = 'Hosting'),
   'manual', null, date '2026-09-12', 'UYU', 40000, 8800, 48800,
   null, null, null, null)
on conflict (id) do nothing;

insert into public.sales_lines (id, sales_document_id, description, amount)
values
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'Cableado y switches', 1000000),
  ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'Configuracion de red', 500000),
  ('e1000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', 'Servidor de archivos', 1200),
  ('e1000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004', 'Hosting anual', 250000),
  ('e1000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000005', 'Camaras de seguridad', 100000),
  ('e1000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000006', 'Equipos importados', 500),
  ('e1000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000007', 'Soporte mensual', 40000)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Costs (cost documents + one line each). Direct costs carry a job,
-- general ones do not (cost_documents_classification_project_check).
-- The last one mimics the quick "+ Agregar gasto" flow: provisional, no
-- supplier, no tax.
-- ---------------------------------------------------------------------
insert into public.cost_documents (
  id, company_id, supplier_id, project_id, classification, category, status,
  document_date, currency, net_amount, tax_amount, total_amount
)
values
  ('f0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'direct', 'equipment', 'confirmed',
   date '2026-08-12', 'CLP', 300000, 57000, 357000),
  ('f0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'direct', 'materials', 'confirmed',
   date '2026-09-03', 'USD', 250, 0, 250),
  ('f0000000-0000-4000-8000-000000000003',
   'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   null, 'general', 'other', 'confirmed',
   date '2026-09-01', 'CLP', 100000, 19000, 119000),
  ('f0000000-0000-4000-8000-000000000004',
   'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
   'd0000000-0000-4000-8000-000000000003', 'direct', 'transport', 'confirmed',
   date '2026-08-15', 'UYU', 30000, 6600, 36600),
  ('f0000000-0000-4000-8000-000000000005',
   'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
   null, 'general', 'other', 'confirmed',
   date '2026-09-03', 'UYU', 12000, 2640, 14640),
  ('f0000000-0000-4000-8000-000000000006',
   'a0000000-0000-4000-8000-000000000002', null,
   'd0000000-0000-4000-8000-000000000003', 'direct', 'materials', 'provisional',
   date '2026-09-06', 'USD', 120, 0, 120)
on conflict (id) do nothing;

insert into public.cost_lines (id, cost_document_id, description, amount)
values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'Switches y patch panel', 300000),
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 'Discos y memoria', 250),
  ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'Licencias de software', 100000),
  ('f1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000004', 'Flete de equipos', 30000),
  ('f1000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000005', 'Servicios de oficina', 12000),
  ('f1000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000006', 'Cableado', 120)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Access: every user that already exists in this project becomes admin of
-- both demo companies. If nobody has been created yet this inserts nothing;
-- create the user in the Dashboard and run this block again (README).
-- ---------------------------------------------------------------------
insert into public.company_memberships (user_id, company_id, role)
select u.id, c.id, 'admin'
from auth.users u
cross join public.companies c
where c.id in (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002'
)
on conflict (user_id, company_id) do nothing;
