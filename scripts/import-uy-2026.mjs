#!/usr/bin/env node
/**
 * Importa el histórico 2026 de Inmasoft UY desde la plantilla Excel
 * (data/import/Plantilla_Importacion_UY_2026.xlsx) a la base del ERP.
 *
 *   node scripts/import-uy-2026.mjs --target=dev|prod [--dry-run] [--file=<ruta>]
 *
 * Otros modos:
 *   --fetch-fx[=<csv>]          descarga el tipo de cambio histórico (BCU + MonedAPI)
 *                               a data/import/tipos_cambio_2026.csv.
 *   --load-fx[=<csv>]           carga ese CSV en exchange_rate_snapshots sin pisar
 *                               los snapshots existentes.
 *   --schema-check              compara el esquema de dev y prod en las tablas del import.
 *   --verify                    solo las verificaciones (lectura) contra el target.
 *   --cleanup                   (solo dev) deshace lo que registró este import en
 *                               import_batches/import_rows.
 *   --restore=<schema>          (solo prod) restaura las tablas desde el schema de
 *                               backup que crea la ejecución real en prod.
 *   --simulate=cleanup|restore  (solo dev) corre fixture + import + re-import +
 *                               verificaciones + cleanup/restore en UNA transacción
 *                               que siempre termina en ROLLBACK. Requiere
 *                               --fixture=<sql> (datos previos de la empresa).
 *   --allow-schema-diff         (prod) seguir aunque el esquema difiera de dev.
 *
 * Todo se ejecuta con `supabase db query --linked --project-ref <ref>` (Management
 * API, sin contraseña de la base). Cada ejecución contra una base es una sola
 * transacción: la carga entera es un BEGIN ... COMMIT (o ROLLBACK en --dry-run).
 * La lógica vive en funciones pg_temp (no se crea nada en el esquema).
 *
 * Reutiliza la lógica del ERP: generate_recurring_service_occurrences_since_start
 * (backfill de ciclos), link_recurring_service_occurrence_to_invoice (vínculo
 * ciclo-factura y estado facturado/cobrado), ms_licenses_area_ids (área de
 * licencias MS) y los triggers de tipo de cambio de cada documento.
 *
 * Referencias externas (SRV-xxx / PRY-xxx) e idempotencia: cada entidad creada,
 * adoptada o actualizada queda en import_rows (raw_data: entity, ref, action,
 * entity_id, before) bajo un import_batches con file_name 'import-uy-2026:<archivo>'.
 * Una re-ejecución las encuentra ahí y no crea nada nuevo; si no hay cambios
 * tampoco deja un batch nuevo.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(REPO_DIR, 'web');
const OUT_DIR = path.join(REPO_DIR, 'data', 'import', 'out');

const TARGETS = {
  dev: { ref: 'sczgankronafrxybpvnh', name: 'inma-erp-dev' },
  prod: { ref: 'jxkfpkgyvjiyufmfxsfp', name: 'inma-erp-sa-east-1' },
};

const COMPANY_NAME = 'Inmasoft UY';
const BATCH_PREFIX = 'import-uy-2026:';
const DATE_MIN = '2025-12-01';
const DATE_MAX = '2026-12-31';
// Backfill de ciclos: mes de generación hasta octubre 2026 (vencido -> período 2026-09).
const BACKFILL_UNTIL = '2026-10-01';
const BACKUP_SCHEMA = 'backup_20261013_import_uy';

// Totales esperados para este archivo (consigna). Si no coinciden, se aborta.
const EXPECTED = {
  documents: 19,
  net: { USD: 2968.5, UYU: 13400 },
  total: { USD: 3621.55, UYU: 16348 },
  margins: { 'PRY-002': 3500, 'PRY-003': 3400, 'PRY-004': 3500 },
};

// Tablas que el import puede tocar, en orden de dependencias.
const TOUCHED_TABLES = [
  'business_areas', 'clients', 'client_aliases', 'suppliers', 'recurring_services',
  'projects', 'project_quotes', 'project_notes', 'import_batches', 'import_rows',
  'sales_documents', 'sales_lines', 'recurring_service_occurrences',
  'cost_documents', 'cost_lines', 'cost_allocations',
];

const SCHEMA_TABLES = [
  'clients', 'client_aliases', 'companies', 'business_areas', 'suppliers', 'projects',
  'project_quotes', 'project_notes', 'sales_documents', 'sales_lines', 'cost_documents',
  'cost_lines', 'cost_allocations', 'recurring_services', 'recurring_service_occurrences',
  'recurring_service_cost_pools', 'exchange_rate_snapshots', 'import_batches', 'import_rows',
  'personnel',
];

// ---------------------------------------------------------------------------
// Mapeos Excel -> ERP
// ---------------------------------------------------------------------------
const SERVICE_TYPE = { ms_licencias: 'ms_licenses', hosting: 'hosting', starlink: 'starlink', servidor: 'server', otro: 'other' };
const PERIODICITY = { mensual: 'monthly', anual: 'annual' };
const INVOICING_MODE = { anticipado: 'advance', vencido: 'arrears', '': 'arrears' };
const SERVICE_STATUS = { activo: 'active', pausado: 'paused', cancelado: 'cancelled' };
const PROJECT_STATUS = { en_curso: 'en_ejecucion', terminado: 'finalizado', facturado: 'cerrado', cerrado: 'cerrado', cancelado: 'cancelado' };
const CFE_TYPE = { 'e-factura': 'invoice', 'e-ticket': 'invoice', 'nota de credito': 'ignore' };
const EXPENSE_TYPES = ['proyecto', 'servicio', 'pool_licencias_ms', 'general'];
const SUPPORTED_EXPENSE_TYPES = ['proyecto'];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Argumento no reconocido: ${a}`);
    args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function fail(message) {
  console.error(`\nABORTADO: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Lector .xlsx mínimo (zip + XML), sin dependencias. Lee los valores
// calculados (<v>) de las celdas con fórmula.
// ---------------------------------------------------------------------------
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('El archivo no es un .xlsx válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlDecode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const xmlText = (x) => [...x.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join('');

function readWorkbook(file) {
  const f = unzip(readFileSync(file));
  const shared = [...(f['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const rels = {};
  for (const m of f['xl/_rels/workbook.xml.rels'].matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1])?.[1];
    const target = /Target="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) rels[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  const sheets = {};
  for (const m of f['xl/workbook.xml'].matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const name = xmlDecode(/name="([^"]+)"/.exec(m[1])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[1])[1];
    const rows = [];
    for (const rm of f[rels[rid]].matchAll(/<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(/r="(\d+)"/.exec(rm[1])[1]);
      const cells = {};
      for (const cm of (rm[2] || '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = /r="([A-Z]+)\d+"/.exec(cm[1])[1];
        const t = /t="([^"]+)"/.exec(cm[1])?.[1];
        const body = cm[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val = null;
        if (t === 's') val = v != null ? shared[Number(v)] : null;
        else if (t === 'inlineStr') val = xmlText(body);
        else if (t === 'str' || t === 'e') val = v != null ? xmlDecode(v) : null;
        else if (t === 'b') val = v === '1';
        else if (v != null) val = Number(v);
        cells[col] = val;
      }
      rows.push({ r, cells });
    }
    sheets[name] = rows;
  }
  return sheets;
}

// Fila 1 = encabezados (sin " *"), fila 2 = ejemplo (se ignora), datos desde la 3.
function sheetObjects(sheets, name) {
  const rows = sheets[name];
  if (!rows) fail(`falta la hoja "${name}"`);
  const header = rows.find((x) => x.r === 1);
  if (!header) fail(`la hoja "${name}" no tiene encabezados`);
  const cols = Object.entries(header.cells)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([col, v]) => [col, v.replace(/\s*\*\s*$/, '').trim()]);
  const out = [];
  for (const { r, cells } of rows) {
    if (r < 3) continue;
    const obj = { _row: r };
    let empty = true;
    for (const [col, key] of cols) {
      let v = cells[col];
      if (typeof v === 'string') v = v.trim();
      if (v === '' || v === undefined) v = null;
      if (v !== null) empty = false;
      obj[key] = v;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalización de valores
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

function excelDate(v) {
  if (v === null) return null;
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return undefined;
}

function excelPeriod(v) {
  if (v === null) return null;
  if (typeof v === 'number') return excelDate(v)?.slice(0, 7);
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(v).trim());
  return m ? `${m[1]}-${pad(m[2])}` : undefined;
}

function docNumber(v) {
  if (v === null) return null;
  if (typeof v === 'number') return String(Math.round(v));
  const s = String(v).trim();
  return /^\d+(\.0+)?$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

const num = (v) => (v === null ? null : typeof v === 'number' ? v : Number(String(v).replace(',', '.')));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lower = (v) => (v === null ? '' : String(v).trim().toLowerCase());
const noAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const siNo = (v, dflt) => (v === null ? dflt : lower(v) === 'si' || lower(v) === 'sí');
const normName = (s) => noAccents(lower(s)).replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s(s a|sa|s r l|srl|s a s|sas|ltda|spa)$/, '').trim();

function amounts(row) {
  const total = num(row['Total (con IVA)']);
  const rate = num(row['Tasa IVA']) ?? 0;
  let net = num(row['Neto']);
  if (net === null || Number.isNaN(net)) net = round2(total / (1 + rate));
  const tax = round2(total - net);
  return { total: round2(total), rate, net: round2(net), tax };
}

// ---------------------------------------------------------------------------
// Fase 1: validación del Excel -> payload para la base
// ---------------------------------------------------------------------------
function buildPayload(file) {
  const wb = readWorkbook(file);
  const clientsSheet = sheetObjects(wb, 'Clientes');
  const servicesSheet = sheetObjects(wb, 'Servicios');
  const projectsSheet = sheetObjects(wb, 'Proyectos');
  const salesSheet = sheetObjects(wb, 'Ventas');
  const expensesSheet = sheetObjects(wb, 'Gastos');

  const critical = [];
  const warnings = [];
  const skipped = [];
  const crit = (sheet, row, msg) => critical.push(`${sheet} fila ${row}: ${msg}`);
  const warn = (sheet, row, msg) => warnings.push(`${sheet} fila ${row}: ${msg}`);
  const inRange = (d) => d >= DATE_MIN && d <= DATE_MAX;
  const currencyOk = (c) => c === 'USD' || c === 'UYU';

  // Clientes
  const clientNames = new Set();
  const clients = [];
  for (const r of clientsSheet) {
    const name = r['Cliente'];
    if (!name) { crit('Clientes', r._row, 'falta el nombre del cliente'); continue; }
    if (clientNames.has(name)) { crit('Clientes', r._row, `cliente repetido "${name}"`); continue; }
    clientNames.add(name);
    const rut = r['RUT'] === null ? '' : String(typeof r['RUT'] === 'number' ? Math.round(r['RUT']) : r['RUT']).replace(/\D/g, '');
    if (r['Email']) warn('Clientes', r._row, `email "${r['Email']}" no se importa (la tabla clients no tiene email)`);
    clients.push({
      row: r._row, name, rut, exists_flag: r['Ya existe en ERP'] ?? '',
      names: [name, r['Alias'], r['Razón social']].filter(Boolean).map(String),
      notes: r['Notas'] ?? '', raw: r,
    });
  }
  const knownClient = (sheet, row, name) => {
    if (!name) { crit(sheet, row, 'falta el cliente'); return false; }
    if (!clientNames.has(name)) { crit(sheet, row, `cliente "${name}" no está en la hoja Clientes`); return false; }
    return true;
  };

  // Servicios
  const services = [];
  const serviceByRef = new Map();
  const skippedServiceRefs = new Set();
  for (const r of servicesSheet) {
    const ref = r['ID servicio'];
    if (!ref) { crit('Servicios', r._row, 'falta el ID de servicio'); continue; }
    if (serviceByRef.has(ref)) { crit('Servicios', r._row, `ID repetido ${ref}`); continue; }
    knownClient('Servicios', r._row, r['Cliente']);
    const freq = lower(r['Frecuencia']);
    if (freq === 'semestral') {
      skipped.push(`Servicios fila ${r._row} (${ref}): frecuencia semestral no soportada por el ERP, fila omitida`);
      skippedServiceRefs.add(ref);
      continue;
    }
    const type = SERVICE_TYPE[lower(r['Tipo servicio'])];
    const periodicity = PERIODICITY[freq];
    const mode = INVOICING_MODE[lower(r['Modalidad'])];
    const status = SERVICE_STATUS[lower(r['Estado'])];
    const start = excelDate(r['Fecha inicio']);
    const end = excelDate(r['Fecha fin']);
    const price = num(r['Monto por período (sin IVA)']);
    const cost = num(r['Costo fijo por período (sin IVA)']);
    const usesPool = siNo(r['Usa pool licencias MS'], false);
    if (!type) crit('Servicios', r._row, `tipo de servicio "${r['Tipo servicio']}" desconocido`);
    if (!periodicity) crit('Servicios', r._row, `frecuencia "${r['Frecuencia']}" desconocida`);
    if (mode === undefined) crit('Servicios', r._row, `modalidad "${r['Modalidad']}" desconocida`);
    if (!status) crit('Servicios', r._row, `estado "${r['Estado']}" desconocido`);
    if (!r['Área']) crit('Servicios', r._row, 'falta el área');
    if (!currencyOk(r['Moneda'])) crit('Servicios', r._row, `moneda "${r['Moneda']}" no es USD/UYU`);
    if (!start) crit('Servicios', r._row, 'falta o es inválida la fecha de inicio');
    if (end === undefined) crit('Servicios', r._row, 'fecha fin inválida');
    if (!(price > 0)) crit('Servicios', r._row, 'el monto por período debe ser > 0');
    if (cost > 0 && r['Moneda costo'] && r['Moneda costo'] !== r['Moneda']) {
      crit('Servicios', r._row, `moneda del costo (${r['Moneda costo']}) distinta de la del servicio (${r['Moneda']}): el ERP guarda un solo costo fijo en la moneda del servicio`);
    }
    if (!(cost > 0) && !usesPool) warn('Servicios', r._row, `${ref}: servicio sin costo (costo fijo vacío/0 y sin pool)`);
    const svc = {
      row: r._row, ref, client: r['Cliente'], service_type: type, area: r['Área'],
      name: r['Descripción'] || `${r['Tipo servicio']} ${r['Cliente']}`, currency: r['Moneda'], price,
      periodicity, invoicing_mode: mode, start_date: start, end_date: end ?? null, status,
      due_month: periodicity === 'annual' && start ? Number(start.slice(5, 7)) : null,
      fixed_monthly_cost: cost === null ? null : cost, uses_cost_pool: usesPool,
      requires_invoice: siNo(r['Requiere factura'], true), supplier: r['Proveedor'] ?? '',
      notes: r['Notas'] ?? '', raw: r,
    };
    services.push(svc);
    serviceByRef.set(ref, svc);
  }

  // Proyectos
  const projects = [];
  const projectByRef = new Map();
  for (const r of projectsSheet) {
    const ref = r['ID proyecto'];
    if (!ref) { crit('Proyectos', r._row, 'falta el ID de proyecto'); continue; }
    if (projectByRef.has(ref) || serviceByRef.has(ref)) { crit('Proyectos', r._row, `ID repetido ${ref}`); continue; }
    knownClient('Proyectos', r._row, r['Cliente']);
    const status = PROJECT_STATUS[lower(r['Estado'])];
    const start = excelDate(r['Fecha inicio']);
    const end = excelDate(r['Fecha fin']);
    if (!status) crit('Proyectos', r._row, `estado "${r['Estado']}" desconocido`);
    if (!r['Área']) crit('Proyectos', r._row, 'falta el área');
    if (!r['Descripción']) crit('Proyectos', r._row, 'falta la descripción');
    if (!currencyOk(r['Moneda'])) crit('Proyectos', r._row, `moneda "${r['Moneda']}" no es USD/UYU`);
    if (start === undefined || end === undefined) crit('Proyectos', r._row, 'fecha inválida');
    const quoted = num(r['Monto cotizado (sin IVA)']);
    if (quoted === null || !(quoted >= 0)) crit('Proyectos', r._row, 'monto cotizado inválido');
    const p = {
      row: r._row, ref, client: r['Cliente'], quote: r['N° cotización'] === null ? '' : String(r['N° cotización']),
      name: r['Descripción'], area: r['Área'], currency: r['Moneda'], quoted_amount: quoted,
      cost_budget: num(r['Costo presupuestado']), start_date: start ?? null, end_date: end ?? null,
      status, technician: r['Técnico'] ?? '', notes: r['Notas'] ?? '', raw: r,
    };
    projects.push(p);
    projectByRef.set(ref, p);
  }

  // Ventas
  const groups = new Map();
  const servicePeriods = new Map();
  for (const r of salesSheet) {
    const sheet = 'Ventas';
    const cfe = CFE_TYPE[noAccents(lower(r['Tipo CFE']))];
    if (cfe === 'ignore') { skipped.push(`Ventas fila ${r._row}: nota de crédito ignorada`); continue; }
    if (!cfe) { crit(sheet, r._row, `tipo CFE "${r['Tipo CFE']}" desconocido`); continue; }
    if (r['Control'] !== null && r['Control'] !== 'OK') crit(sheet, r._row, `la columna Control dice "${r['Control']}"`);
    const date = excelDate(r['Fecha']);
    const number = docNumber(r['Número']);
    const serie = r['Serie'] === null ? '' : String(r['Serie']).trim();
    const { total, net, tax } = amounts(r);
    const paidAt = excelDate(r['Fecha cobro']);
    const saldo = num(r['Saldo']);
    knownClient(sheet, r._row, r['Cliente']);
    if (!date) crit(sheet, r._row, 'falta o es inválida la fecha');
    else if (!inRange(date)) crit(sheet, r._row, `fecha ${date} fuera de ${DATE_MIN}..${DATE_MAX}`);
    if (!number) crit(sheet, r._row, 'falta el número');
    if (!currencyOk(r['Moneda'])) crit(sheet, r._row, `moneda "${r['Moneda']}" no es USD/UYU`);
    if (!(total > 0)) crit(sheet, r._row, 'el total debe ser > 0');
    if (saldo === null || Number.isNaN(saldo) || saldo < 0) crit(sheet, r._row, 'saldo inválido');
    if (paidAt === undefined) crit(sheet, r._row, 'fecha de cobro inválida');
    const link = r['Vínculo (ID servicio o proyecto)'];
    let kind = null;
    let period = null;
    if (!link) warn(sheet, r._row, 'venta sin vínculo a servicio/proyecto: se importa como factura suelta');
    else if (serviceByRef.has(link) || skippedServiceRefs.has(link)) {
      kind = 'SRV';
      if (skippedServiceRefs.has(link)) crit(sheet, r._row, `el servicio ${link} se omitió (frecuencia no soportada)`);
      period = excelPeriod(r['Período (AAAA-MM)']);
      if (!period) crit(sheet, r._row, `venta del servicio ${link} sin período válido`);
      else {
        const key = `${link}|${period}`;
        if (servicePeriods.has(key)) crit(sheet, r._row, `(servicio, período) ${link} ${period} repetido (también en la fila ${servicePeriods.get(key)})`);
        else servicePeriods.set(key, r._row);
        if (period < '2026-01') warn(sheet, r._row, `período ${period}: ingreso que no entra en el cierre 2026`);
      }
      const svc = serviceByRef.get(link);
      if (svc && svc.client !== r['Cliente']) crit(sheet, r._row, `el servicio ${link} es de "${svc.client}", no de "${r['Cliente']}"`);
      if (svc && svc.currency !== r['Moneda']) crit(sheet, r._row, `moneda ${r['Moneda']} distinta de la del servicio ${link} (${svc.currency})`);
    } else if (projectByRef.has(link)) {
      kind = 'PRY';
      const p = projectByRef.get(link);
      if (p.client !== r['Cliente']) crit(sheet, r._row, `el proyecto ${link} es de "${p.client}", no de "${r['Cliente']}"`);
    } else crit(sheet, r._row, `vínculo ${link} no existe en Servicios ni Proyectos`);

    const key = serie ? `${serie}-${number}` : number;
    if (!groups.has(key)) {
      groups.set(key, {
        number: key, serie, raw_number: number, date, client: r['Cliente'], currency: r['Moneda'],
        paid: true, paid_at: null, lines: [], rows: [],
      });
    }
    const g = groups.get(key);
    if (g.client !== r['Cliente'] || g.currency !== r['Moneda']) {
      crit(sheet, r._row, `la factura ${key} tiene otro cliente o moneda en la fila ${g.rows[0]}`);
    }
    if (g.date !== date) warn(sheet, r._row, `la factura ${key} tiene fechas distintas entre filas; se usa ${g.date}`);
    g.rows.push(r._row);
    g.paid = g.paid && saldo === 0;
    if (saldo === 0 && paidAt && (!g.paid_at || paidAt > g.paid_at)) g.paid_at = paidAt;
    g.lines.push({
      row: r._row, description: r['Descripción'] || (period ? `${link} ${period}` : link || 'Venta'),
      net, tax, total, kind, ref: link ?? null, period: period ? `${period}-01` : null, saldo, raw: r,
    });
  }
  const sales = [...groups.values()].map((g) => ({
    ...g,
    net: round2(g.lines.reduce((s, l) => s + l.net, 0)),
    tax: round2(g.lines.reduce((s, l) => s + l.tax, 0)),
    total: round2(g.lines.reduce((s, l) => s + l.total, 0)),
    paid_at: g.paid ? (g.paid_at ?? g.date) : null,
  }));

  // Gastos
  const expenses = [];
  for (const r of expensesSheet) {
    const sheet = 'Gastos';
    if (r['Control'] !== null && r['Control'] !== 'OK') crit(sheet, r._row, `la columna Control dice "${r['Control']}"`);
    const type = lower(r['Tipo gasto']);
    const date = excelDate(r['Fecha']);
    const { total, net, tax } = amounts(r);
    const period = excelPeriod(r['Período (AAAA-MM)']);
    if (!EXPENSE_TYPES.includes(type)) crit(sheet, r._row, `tipo de gasto "${r['Tipo gasto']}" desconocido`);
    else if (!SUPPORTED_EXPENSE_TYPES.includes(type)) crit(sheet, r._row, `tipo de gasto "${type}" no implementado en este script (este archivo solo trae gastos de proyecto)`);
    if (!date) crit(sheet, r._row, 'falta o es inválida la fecha');
    else if (!inRange(date)) crit(sheet, r._row, `fecha ${date} fuera de ${DATE_MIN}..${DATE_MAX}`);
    if (!currencyOk(r['Moneda'])) crit(sheet, r._row, `moneda "${r['Moneda']}" no es USD/UYU`);
    if (!(total > 0)) crit(sheet, r._row, 'el total debe ser > 0');
    if (!period) crit(sheet, r._row, 'falta o es inválido el período');
    const link = r['Vínculo (ID)'];
    if (type === 'proyecto' && !projectByRef.has(link)) crit(sheet, r._row, `proyecto ${link} no existe en Proyectos`);
    if (!r['Proveedor']) warn(sheet, r._row, 'gasto sin proveedor (supplier vacío)');
    if (r['Pagado'] !== null) warn(sheet, r._row, 'la columna Pagado no se importa (cost_documents no tiene estado de pago)');
    expenses.push({
      row: r._row, date, supplier: r['Proveedor'] ?? '', supplier_rut: r['RUT proveedor'] ? String(r['RUT proveedor']).replace(/\D/g, '') : '',
      number: docNumber(r['N° documento']) ?? '', description: r['Descripción'] ?? '', currency: r['Moneda'],
      net, tax, total, type, ref: link ?? null, area: r['Área'] ?? '', period: period ? `${period}-01` : null,
      raw: r,
    });
  }

  // Técnicos / cotizaciones
  for (const p of projects) {
    if (!p.quote) continue;
    if (projects.filter((x) => x.quote === p.quote).length > 1) crit('Proyectos', p.row, `N° de cotización ${p.quote} repetido`);
  }

  // Totales esperados
  const totals = { documents: sales.length, net: {}, total: {} };
  for (const s of sales) {
    totals.net[s.currency] = round2((totals.net[s.currency] ?? 0) + s.net);
    totals.total[s.currency] = round2((totals.total[s.currency] ?? 0) + s.total);
  }
  const sameMap = (a, b) => Object.keys({ ...a, ...b }).every((k) => round2(a[k] ?? 0) === round2(b[k] ?? 0));
  if (totals.documents !== EXPECTED.documents || !sameMap(totals.net, EXPECTED.net) || !sameMap(totals.total, EXPECTED.total)) {
    critical.push(`Totales: se esperaban ${EXPECTED.documents} documentos, neto ${JSON.stringify(EXPECTED.net)}, total ${JSON.stringify(EXPECTED.total)}; el archivo da ${totals.documents}, ${JSON.stringify(totals.net)}, ${JSON.stringify(totals.total)}`);
  }

  const areas = [...new Set([...services.map((s) => s.area), ...projects.map((p) => p.area), ...expenses.map((e) => e.area)].filter(Boolean))];
  const suppliers = [];
  for (const [name, rut] of [...services.map((s) => [s.supplier, '']), ...expenses.map((e) => [e.supplier, e.supplier_rut])]) {
    if (!name) continue;
    const existing = suppliers.find((x) => normName(x.name) === normName(name));
    if (existing) { if (!existing.rut && rut) existing.rut = rut; } else suppliers.push({ name, rut });
  }

  const dates = [...sales.map((s) => s.date), ...expenses.map((e) => e.date)].filter(Boolean).sort();
  const payload = {
    company_name: COMPANY_NAME,
    batch_file_name: `${BATCH_PREFIX}${path.basename(file)}`,
    backfill_until: BACKFILL_UNTIL,
    excel_rows: clientsSheet.length + servicesSheet.length + projectsSheet.length + salesSheet.length + expensesSheet.length,
    oldest_date: dates[0] ?? null,
    areas, clients, suppliers, services, projects, sales, expenses,
    expected: {
      ...EXPECTED,
      lines: sales.reduce((s, g) => s + g.lines.length, 0),
      numbers: sales.map((s) => s.number),
      service_refs: services.map((s) => s.ref),
      invoiced_periods: Object.fromEntries(services.map((s) => [s.ref, sales.flatMap((g) => g.lines).filter((l) => l.ref === s.ref).map((l) => l.period).sort()])),
    },
  };
  return { payload, critical, warnings, skipped, totals };
}

// ---------------------------------------------------------------------------
// SQL (funciones pg_temp: viven solo en la sesión de esta transacción)
// ---------------------------------------------------------------------------
const SQL_FUNCTIONS = String.raw`
create temp table _imp_log (
  seq serial, pass int, sheet text, row_no int, entity text, ref text, action text,
  entity_id uuid, detail jsonb, raw jsonb
) on commit drop;
create temp table _imp_checks (name text, ok boolean, detail text) on commit drop;

create function pg_temp.imp_norm(t text) returns text language sql immutable as $f$
  select btrim(regexp_replace(
    btrim(regexp_replace(coalesce(public.search_normalize(t), ''), '[^a-z0-9]+', ' ', 'g')),
    '\s(s a|sa|s r l|srl|s a s|sas|ltda|spa)$', ''))
$f$;

create function pg_temp.imp_log(p_pass int, p_sheet text, p_row int, p_entity text, p_ref text,
  p_action text, p_id uuid, p_detail jsonb, p_raw jsonb) returns void language sql as $f$
  insert into _imp_log (pass, sheet, row_no, entity, ref, action, entity_id, detail, raw)
  values (p_pass, p_sheet, p_row, p_entity, p_ref, p_action, p_id, p_detail, p_raw)
$f$;

-- Entidad registrada por una ejecución anterior de este import (creada o adoptada).
create function pg_temp.imp_registry(p_company uuid, p_entity text, p_ref text) returns uuid
language sql stable as $f$
  select (ir.raw_data->>'entity_id')::uuid
  from public.import_rows ir
  join public.import_batches ib on ib.id = ir.import_batch_id
  where ib.company_id = p_company
    and ib.file_name like 'import-uy-2026:%'
    and ir.raw_data->>'entity' = p_entity
    and ir.raw_data->>'ref' = p_ref
    and ir.raw_data->>'action' in ('created', 'adopted')
  order by ib.imported_at desc
  limit 1
$f$;

create function pg_temp.imp_company(p_name text) returns uuid language plpgsql stable as $f$
declare
  v_cnt int;
  v_id uuid;
  v_country text;
begin
  select count(*) into v_cnt from public.companies where name = p_name;
  if v_cnt <> 1 then
    raise exception 'IMPORT_ABORT: se esperaba exactamente 1 empresa "%" y hay %', p_name, v_cnt;
  end if;
  select id, upper(coalesce(country, '')) into v_id, v_country from public.companies where name = p_name;
  if v_country not in ('UY', 'URUGUAY') then
    raise exception 'IMPORT_ABORT: la empresa "%" no es de Uruguay (country=%)', p_name, v_country;
  end if;
  return v_id;
end;
$f$;

create function pg_temp.imp_run(p jsonb, p_pass int) returns void language plpgsql as $f$
declare
  v_company uuid := pg_temp.imp_company(p->>'company_name');
  v_company_currency text;
  v_company_country text;
  v_cnt int;
  v_n int;
  v_id uuid;
  v_id2 uuid;
  v_txt text;
  v_how text;
  e jsonb;
  l jsonb;
  v_rec record;
  v_svc record;
  v_before jsonb;
  v_diffs jsonb;
  v_norms text[];
  v_areas jsonb := '{}';
  v_clients jsonb := '{}';
  v_suppliers jsonb := '{}';
  v_services jsonb := '{}';
  v_projects jsonb := '{}';
  v_doc uuid;
  v_area uuid;
  v_project uuid;
  v_status text;
  v_period date;
  v_due_month date;
  v_due date;
  v_batch uuid;
begin
  select currency, country into v_company_currency, v_company_country from public.companies where id = v_company;

  -- 0. Cotización: cada mes con documentos en otra moneda necesita el snapshot
  -- de la moneda de la empresa de ese mismo mes (sin él quedarían sin convertir).
  select string_agg(to_char(m, 'YYYY-MM'), ', ' order by m) into v_txt
  from (
    select date_trunc('month', (s->>'date')::date)::date as m
    from jsonb_array_elements(p->'sales') s where s->>'currency' <> v_company_currency
    union
    select date_trunc('month', (x->>'date')::date)::date
    from jsonb_array_elements(p->'expenses') x where x->>'currency' <> v_company_currency
  ) q
  where v_company_currency <> 'USD'
    and not exists (select 1 from public.exchange_rate_snapshots es
                    where es.currency = v_company_currency and es.period = q.m and es.ars_per_usd > 0);
  if v_txt is not null then
    raise exception 'IMPORT_ABORT: faltan snapshots de tipo de cambio % para %: cargar con --load-fx', v_company_currency, v_txt;
  end if;

  -- 1. Áreas de negocio --------------------------------------------------
  for v_txt in select jsonb_array_elements_text(p->'areas') loop
    v_id := null;
    v_how := 'nombre';
    select id into v_id from public.business_areas
    where company_id = v_company and lower(btrim(name)) = lower(btrim(v_txt));
    if v_id is null and lower(btrim(v_txt)) in ('licencias ms', 'microsoft 365', 'licencias microsoft') then
      select count(*), min(x::text)::uuid into v_cnt, v_id from public.ms_licenses_area_ids(v_company) x;
      if v_cnt <> 1 then v_id := null; end if;
      v_how := 'área de licencias MS existente';
    end if;
    if v_id is null then
      insert into public.business_areas (company_id, name) values (v_company, btrim(v_txt)) returning id into v_id;
      perform pg_temp.imp_log(p_pass, 'Areas', null, 'area', v_txt, 'created', v_id, null, null);
    else
      perform pg_temp.imp_log(p_pass, 'Areas', null, 'area', v_txt, 'skipped', v_id,
        jsonb_build_object('match', v_how, 'erp_name', (select name from public.business_areas where id = v_id)), null);
    end if;
    v_areas := v_areas || jsonb_build_object(lower(btrim(v_txt)), v_id);
  end loop;

  -- 2. Clientes ----------------------------------------------------------
  for e in select jsonb_array_elements(p->'clients') loop
    v_id := null;
    v_how := null;
    if coalesce(e->>'rut', '') <> '' then
      select count(*), min(id::text)::uuid into v_cnt, v_id from public.clients
      where company_id = v_company and regexp_replace(coalesce(tax_id, ''), '\D', '', 'g') = e->>'rut';
      if v_cnt > 1 then
        raise exception 'IMPORT_ABORT: el RUT % coincide con % clientes', e->>'rut', v_cnt;
      end if;
      v_how := 'rut';
    end if;
    if v_id is null then
      v_norms := array(select distinct pg_temp.imp_norm(x) from jsonb_array_elements_text(e->'names') x where btrim(x) <> '');
      select count(distinct cid), min(cid::text)::uuid into v_cnt, v_id from (
        select c.id as cid from public.clients c
        where c.company_id = v_company and pg_temp.imp_norm(c.name) = any(v_norms)
        union
        select a.client_id from public.client_aliases a
        where a.company_id = v_company and pg_temp.imp_norm(a.external_name) = any(v_norms)
      ) m;
      if v_cnt > 1 then
        raise exception 'IMPORT_ABORT: el cliente "%" coincide con % clientes del ERP', e->>'name', v_cnt;
      end if;
      v_how := 'nombre/alias';
    end if;

    if v_id is not null then
      select * into v_rec from public.clients where id = v_id;
      if coalesce(e->>'rut', '') <> '' and coalesce(btrim(v_rec.tax_id), '') <> ''
         and regexp_replace(v_rec.tax_id, '\D', '', 'g') <> e->>'rut' then
        raise exception 'IMPORT_ABORT: el cliente "%" del ERP tiene RUT % y el Excel dice %', v_rec.name, v_rec.tax_id, e->>'rut';
      end if;
      v_before := jsonb_build_object('tax_id', v_rec.tax_id, 'notes', v_rec.notes);
      update public.clients
      set tax_id = case when coalesce(btrim(tax_id), '') = '' and coalesce(e->>'rut', '') <> '' then e->>'rut' else tax_id end,
          notes = case when coalesce(btrim(notes), '') = '' and coalesce(e->>'notes', '') <> '' then e->>'notes' else notes end
      where id = v_id
        and ((coalesce(btrim(tax_id), '') = '' and coalesce(e->>'rut', '') <> '')
          or (coalesce(btrim(notes), '') = '' and coalesce(e->>'notes', '') <> ''));
      get diagnostics v_n = row_count;
      perform pg_temp.imp_log(p_pass, 'Clientes', (e->>'row')::int, 'client', e->>'name',
        case when v_n > 0 then 'updated' else 'skipped' end, v_id,
        jsonb_build_object('match', v_how, 'erp_name', v_rec.name, 'excel_flag', e->>'exists_flag', 'before', v_before,
          'notes_kept', coalesce(btrim(v_rec.notes), '') <> '' and coalesce(e->>'notes', '') <> ''),
        e->'raw');
    else
      insert into public.clients (company_id, name, tax_id, country, notes)
      values (v_company, e->>'name', nullif(e->>'rut', ''), v_company_country, nullif(e->>'notes', ''))
      returning id into v_id;
      perform pg_temp.imp_log(p_pass, 'Clientes', (e->>'row')::int, 'client', e->>'name', 'created', v_id,
        jsonb_build_object('excel_flag', e->>'exists_flag'), e->'raw');
    end if;

    -- Alias: nombre del Excel, alias y razón social que no sean ya el nombre.
    for v_txt in select distinct btrim(x) from jsonb_array_elements_text(e->'names') x where btrim(x) <> '' loop
      continue when lower(v_txt) = lower((select name from public.clients where id = v_id));
      v_id2 := null;
      select client_id into v_id2 from public.client_aliases
      where company_id = v_company and lower(external_name) = lower(v_txt) limit 1;
      if v_id2 is null then
        insert into public.client_aliases (company_id, external_name, client_id)
        values (v_company, v_txt, v_id) returning id into v_id2;
        perform pg_temp.imp_log(p_pass, 'Clientes', (e->>'row')::int, 'client_alias', v_txt, 'created', v_id2, null, null);
      elsif v_id2 <> v_id then
        raise exception 'IMPORT_ABORT: el alias "%" ya pertenece a otro cliente', v_txt;
      end if;
    end loop;

    v_clients := v_clients || jsonb_build_object(e->>'name', v_id);
  end loop;

  -- 3. Proveedores -------------------------------------------------------
  for e in select jsonb_array_elements(p->'suppliers') loop
    select count(*), min(id::text)::uuid into v_cnt, v_id from public.suppliers
    where company_id = v_company and pg_temp.imp_norm(name) = pg_temp.imp_norm(e->>'name');
    if v_cnt > 1 then
      raise exception 'IMPORT_ABORT: el proveedor "%" coincide con % proveedores', e->>'name', v_cnt;
    elsif v_cnt = 1 then
      perform pg_temp.imp_log(p_pass, 'Proveedores', null, 'supplier', e->>'name', 'skipped', v_id, null, null);
    else
      insert into public.suppliers (company_id, name, tax_id, country)
      values (v_company, e->>'name', nullif(e->>'rut', ''), v_company_country) returning id into v_id;
      perform pg_temp.imp_log(p_pass, 'Proveedores', null, 'supplier', e->>'name', 'created', v_id, null, null);
    end if;
    v_suppliers := v_suppliers || jsonb_build_object(e->>'name', v_id);
  end loop;

  -- 4. Servicios recurrentes ---------------------------------------------
  for e in select jsonb_array_elements(p->'services') loop
    v_id := pg_temp.imp_registry(v_company, 'service', e->>'ref');
    if v_id is not null and exists (select 1 from public.recurring_services where id = v_id) then
      perform pg_temp.imp_log(p_pass, 'Servicios', (e->>'row')::int, 'service', e->>'ref', 'skipped', v_id,
        jsonb_build_object('match', 'ya importado'), e->'raw');
    else
      -- Un servicio igual ya cargado a mano (mismo cliente, tipo, moneda y
      -- frecuencia, no cancelado): se adopta en vez de duplicarlo.
      select count(*), min(s.id::text)::uuid into v_cnt, v_id
      from public.recurring_services s
      where s.company_id = v_company
        and s.client_id = (v_clients->>(e->>'client'))::uuid
        and s.service_type = e->>'service_type'
        and s.currency = e->>'currency'
        and s.periodicity = e->>'periodicity'
        and s.status <> 'cancelled'
        and s.id::text not in (select value from jsonb_each_text(v_services))
        and not exists (
          select 1 from public.import_rows ir
          join public.import_batches ib on ib.id = ir.import_batch_id
          where ib.company_id = v_company and ib.file_name like 'import-uy-2026:%'
            and ir.raw_data->>'entity' = 'service' and ir.raw_data->>'entity_id' = s.id::text
            and ir.raw_data->>'ref' <> e->>'ref'
        );
      if v_cnt > 1 then
        raise exception 'IMPORT_ABORT: % servicios del ERP podrían ser %; no se puede elegir uno', v_cnt, e->>'ref';
      elsif v_cnt = 1 then
        -- Se actualiza con el Excel: precio, pool y costo fijo (si el Excel trae
        -- uno > 0); la fecha de inicio solo si la del Excel es anterior. El resto
        -- se conserva y queda listado como diferencia no aplicada.
        select * into v_svc from public.recurring_services where id = v_id;
        v_before := jsonb_build_object('price', v_svc.price, 'uses_cost_pool', v_svc.uses_cost_pool,
          'fixed_monthly_cost', v_svc.fixed_monthly_cost, 'start_date', v_svc.start_date);
        update public.recurring_services
        set price = (e->>'price')::numeric,
            uses_cost_pool = (e->>'uses_cost_pool')::boolean,
            fixed_monthly_cost = case when coalesce((e->>'fixed_monthly_cost')::numeric, 0) > 0
              then (e->>'fixed_monthly_cost')::numeric else fixed_monthly_cost end,
            start_date = least(start_date, (e->>'start_date')::date)
        where id = v_id;
        select s.*, a.name as area_name into v_svc
        from public.recurring_services s left join public.business_areas a on a.id = s.business_area_id
        where s.id = v_id;
        v_diffs := jsonb_strip_nulls(jsonb_build_object(
          'price', case when v_svc.price <> (e->>'price')::numeric then jsonb_build_array(v_svc.price, (e->>'price')::numeric) end,
          'start_date', case when v_svc.start_date <> (e->>'start_date')::date then jsonb_build_array(v_svc.start_date, e->>'start_date') end,
          'end_date', case when v_svc.end_date is distinct from (e->>'end_date')::date then jsonb_build_array(v_svc.end_date, e->>'end_date') end,
          'invoicing_mode', case when v_svc.invoicing_mode <> e->>'invoicing_mode' then jsonb_build_array(v_svc.invoicing_mode, e->>'invoicing_mode') end,
          'status', case when v_svc.status <> e->>'status' then jsonb_build_array(v_svc.status, e->>'status') end,
          'fixed_monthly_cost', case when v_svc.fixed_monthly_cost is distinct from (e->>'fixed_monthly_cost')::numeric then jsonb_build_array(v_svc.fixed_monthly_cost, (e->>'fixed_monthly_cost')::numeric) end,
          'uses_cost_pool', case when v_svc.uses_cost_pool <> (e->>'uses_cost_pool')::boolean then jsonb_build_array(v_svc.uses_cost_pool, (e->>'uses_cost_pool')::boolean) end,
          'requires_invoice', case when v_svc.requires_invoice <> (e->>'requires_invoice')::boolean then jsonb_build_array(v_svc.requires_invoice, (e->>'requires_invoice')::boolean) end,
          'area', case when v_svc.business_area_id is distinct from (v_areas->>lower(btrim(e->>'area')))::uuid then jsonb_build_array(v_svc.area_name, e->>'area') end
        ));
        perform pg_temp.imp_log(p_pass, 'Servicios', (e->>'row')::int, 'service', e->>'ref', 'adopted', v_id,
          jsonb_build_object('erp_name', v_svc.name, 'before', v_before,
            'after', jsonb_build_object('price', v_svc.price, 'uses_cost_pool', v_svc.uses_cost_pool,
              'fixed_monthly_cost', v_svc.fixed_monthly_cost, 'start_date', v_svc.start_date),
            'not_applied_erp_vs_excel', v_diffs), e->'raw');
      else
        insert into public.recurring_services (
          company_id, client_id, name, price, currency, periodicity, start_date, end_date,
          business_area_id, service_type, invoicing_mode, due_month, status, fixed_monthly_cost,
          uses_cost_pool, requires_invoice, notes
        ) values (
          v_company, (v_clients->>(e->>'client'))::uuid, e->>'name', (e->>'price')::numeric, e->>'currency',
          e->>'periodicity', (e->>'start_date')::date, (e->>'end_date')::date,
          (v_areas->>lower(btrim(e->>'area')))::uuid, e->>'service_type', e->>'invoicing_mode',
          (e->>'due_month')::smallint, e->>'status', (e->>'fixed_monthly_cost')::numeric,
          (e->>'uses_cost_pool')::boolean, (e->>'requires_invoice')::boolean, nullif(e->>'notes', '')
        ) returning id into v_id;
        perform pg_temp.imp_log(p_pass, 'Servicios', (e->>'row')::int, 'service', e->>'ref', 'created', v_id, null, e->'raw');
      end if;
    end if;
    v_services := v_services || jsonb_build_object(e->>'ref', v_id);
  end loop;

  -- 5. Proyectos ---------------------------------------------------------
  for e in select jsonb_array_elements(p->'projects') loop
    if e->>'currency' <> v_company_currency then
      raise exception 'IMPORT_ABORT: el proyecto % está en % y la empresa en % (projects no tiene moneda propia)', e->>'ref', e->>'currency', v_company_currency;
    end if;
    v_id := pg_temp.imp_registry(v_company, 'project', e->>'ref');
    if v_id is not null and exists (select 1 from public.projects where id = v_id) then
      perform pg_temp.imp_log(p_pass, 'Proyectos', (e->>'row')::int, 'project', e->>'ref', 'skipped', v_id,
        jsonb_build_object('match', 'ya importado'), e->'raw');
    else
      v_txt := null;
      if coalesce(e->>'technician', '') <> '' then
        select name into v_txt from public.personnel
        where company_id = v_company and pg_temp.imp_norm(name) = pg_temp.imp_norm(e->>'technician') limit 1;
        if v_txt is null then
          perform pg_temp.imp_log(p_pass, 'Proyectos', (e->>'row')::int, 'project', e->>'ref', 'warning', null,
            jsonb_build_object('message', 'técnico "' || (e->>'technician') || '" no existe en personnel: queda vacío'), null);
        end if;
      end if;
      insert into public.projects (
        company_id, client_id, business_area_id, name, start_date, end_date, status, responsible,
        quoted_amount, cost_budget, closed_at
      ) values (
        v_company, (v_clients->>(e->>'client'))::uuid, (v_areas->>lower(btrim(e->>'area')))::uuid, e->>'name',
        (e->>'start_date')::date, (e->>'end_date')::date, e->>'status', v_txt,
        (e->>'quoted_amount')::numeric, (e->>'cost_budget')::numeric,
        case when e->>'status' in ('finalizado', 'cerrado', 'cancelado')
          then (coalesce((e->>'end_date')::date, (e->>'start_date')::date)::timestamp + interval '12 hours') at time zone 'America/Montevideo'
        end
      ) returning id into v_id;
      perform pg_temp.imp_log(p_pass, 'Proyectos', (e->>'row')::int, 'project', e->>'ref', 'created', v_id,
        jsonb_build_object('notes', e->>'notes'), e->'raw');
      if coalesce(e->>'quote', '') <> '' then
        if exists (select 1 from public.project_quotes where company_id = v_company and quote_number = e->>'quote') then
          perform pg_temp.imp_log(p_pass, 'Proyectos', (e->>'row')::int, 'project_quote', e->>'quote', 'warning', null,
            jsonb_build_object('message', 'la cotización ya existe en otro proyecto: no se vincula'), null);
        else
          insert into public.project_quotes (project_id, company_id, quote_number)
          values (v_id, v_company, e->>'quote') returning id into v_id2;
          perform pg_temp.imp_log(p_pass, 'Proyectos', (e->>'row')::int, 'project_quote', e->>'quote', 'created', v_id2, null, null);
        end if;
      end if;
    end if;
    v_projects := v_projects || jsonb_build_object(e->>'ref', v_id);
  end loop;

  -- 6. Ventas: un documento por (serie, número), una línea por fila -------
  for e in select jsonb_array_elements(p->'sales') loop
    select id, client_id, currency, total_amount into v_rec from public.sales_documents
    where company_id = v_company and document_type = 'invoice' and document_number = e->>'number';
    if found then
      if v_rec.client_id <> (v_clients->>(e->>'client'))::uuid or v_rec.currency <> e->>'currency'
         or v_rec.total_amount <> (e->>'total')::numeric then
        raise exception 'IMPORT_ABORT: ya existe la factura % con otro cliente, moneda o total', e->>'number';
      end if;
      v_doc := v_rec.id;
      perform pg_temp.imp_log(p_pass, 'Ventas', (e->'rows'->>0)::int, 'sales_document', e->>'number', 'skipped', v_doc,
        jsonb_build_object('match', 'ya existe (empresa, tipo, número)'), null);
    else
      -- Área y proyecto del documento: los de sus líneas, si son uno solo.
      select count(distinct a), min(a::text)::uuid, count(*) - count(a)
      into v_cnt, v_area, v_n
      from (
        select case l2->>'kind'
          when 'PRY' then (select business_area_id from public.projects where id = (v_projects->>(l2->>'ref'))::uuid)
          when 'SRV' then (select business_area_id from public.recurring_services where id = (v_services->>(l2->>'ref'))::uuid)
        end as a
        from jsonb_array_elements(e->'lines') l2
      ) x;
      if v_cnt <> 1 or v_n > 0 then v_area := null; end if;
      select count(distinct l2->>'ref'), min(l2->>'ref'), count(*) filter (where l2->>'kind' is distinct from 'PRY')
      into v_cnt, v_txt, v_n
      from jsonb_array_elements(e->'lines') l2;
      v_project := case when v_cnt = 1 and v_n = 0 then (v_projects->>v_txt)::uuid end;

      insert into public.sales_documents (
        company_id, client_id, document_type, document_date, currency, net_amount, tax_amount, total_amount,
        business_area_id, project_id, source, document_number, payment_status, payment_status_updated_at, paid_at
      ) values (
        v_company, (v_clients->>(e->>'client'))::uuid, 'invoice', (e->>'date')::date, e->>'currency',
        (e->>'net')::numeric, (e->>'tax')::numeric, (e->>'total')::numeric,
        v_area, v_project, 'import', e->>'number',
        case when (e->>'paid')::boolean then 'pagado' else 'pendiente' end, now(), (e->>'paid_at')::date
      ) returning id into v_doc;
      insert into public.sales_lines (sales_document_id, description, amount)
      select v_doc, l2->>'description', (l2->>'net')::numeric
      from jsonb_array_elements(e->'lines') with ordinality as t(l2, i)
      order by i;
      perform pg_temp.imp_log(p_pass, 'Ventas', (e->'rows'->>0)::int, 'sales_document', e->>'number', 'created', v_doc,
        jsonb_build_object('lines', jsonb_array_length(e->'lines'), 'rows', e->'rows',
          'project', case when v_project is not null then v_txt end,
          'payment_status', case when (e->>'paid')::boolean then 'pagado' else 'pendiente' end),
        (select jsonb_agg(l2->'raw') from jsonb_array_elements(e->'lines') l2));
    end if;

    -- Ciclos de servicio: crear o actualizar (servicio, período) y vincularlo.
    for l in select x from jsonb_array_elements(e->'lines') x where x->>'kind' = 'SRV' loop
      select * into v_svc from public.recurring_services where id = (v_services->>(l->>'ref'))::uuid;
      if v_svc.currency <> e->>'currency' then
        raise exception 'IMPORT_ABORT: la factura % está en % y el servicio % en %', e->>'number', e->>'currency', l->>'ref', v_svc.currency;
      end if;
      v_period := (l->>'period')::date;
      select * into v_rec from public.recurring_service_occurrences
      where recurring_service_id = v_svc.id and period = v_period;
      if not found then
        -- Misma regla de vencimiento que generate_recurring_service_occurrences_for_month.
        if v_svc.periodicity = 'monthly' then
          v_due_month := case when v_svc.invoicing_mode = 'arrears' then (v_period + interval '1 month')::date else v_period end;
        else
          v_due_month := make_date(extract(year from v_period)::int + case when v_svc.invoicing_mode = 'arrears' then 1 else 0 end,
            coalesce(v_svc.due_month, 1), 1);
        end if;
        v_due := v_due_month + (least(coalesce(v_svc.due_day, 1),
          extract(day from (v_due_month + interval '1 month - 1 day'))::int) - 1);
        insert into public.recurring_service_occurrences (
          recurring_service_id, period, invoice_due_date, collection_due_date, amount, currency, status
        ) values (
          v_svc.id, v_period, v_due, v_due, (l->>'net')::numeric, v_svc.currency,
          case when v_svc.requires_invoice then 'pending_invoice' else 'pending_collection' end
        ) returning id into v_id;
        perform pg_temp.imp_log(p_pass, 'Ventas', (l->>'row')::int, 'cycle', (l->>'ref') || ' ' || to_char(v_period, 'YYYY-MM'),
          'created', v_id, jsonb_build_object('origin', 'factura ' || (e->>'number')), null);
        select * into v_rec from public.recurring_service_occurrences where id = v_id;
      end if;

      if v_rec.sales_document_id is null then
        if v_rec.status = 'void' then
          raise exception 'IMPORT_ABORT: el ciclo % % está anulado', l->>'ref', v_period;
        end if;
        v_before := jsonb_build_object('status', v_rec.status, 'invoiced_at', v_rec.invoiced_at,
          'collected_at', v_rec.collected_at, 'link_review', v_rec.link_review, 'amount', v_rec.amount,
          'exchange_rate', v_rec.exchange_rate, 'exchange_rate_period', v_rec.exchange_rate_period);
        v_status := public.link_recurring_service_occurrence_to_invoice(v_rec.id, v_doc);
        update public.recurring_service_occurrences set amount = (l->>'net')::numeric
        where id = v_rec.id and amount <> (l->>'net')::numeric;
        perform pg_temp.imp_log(p_pass, 'Ventas', (l->>'row')::int, 'cycle', (l->>'ref') || ' ' || to_char(v_period, 'YYYY-MM'),
          'linked', v_rec.id, jsonb_build_object('status', v_status, 'sales_document', e->>'number',
            'amount', (l->>'net')::numeric, 'before', v_before), null);
      elsif v_rec.sales_document_id = v_doc then
        perform pg_temp.imp_log(p_pass, 'Ventas', (l->>'row')::int, 'cycle', (l->>'ref') || ' ' || to_char(v_period, 'YYYY-MM'),
          'skipped', v_rec.id, jsonb_build_object('match', 'ya vinculado a ' || (e->>'number')), null);
      else
        perform pg_temp.imp_log(p_pass, 'Ventas', (l->>'row')::int, 'cycle', (l->>'ref') || ' ' || to_char(v_period, 'YYYY-MM'),
          'warning', v_rec.id, jsonb_build_object('message', 'el ciclo ya está vinculado a otro documento: no se cambia'), null);
      end if;
    end loop;
  end loop;

  -- 6b. Backfill de ciclos desde el inicio de cada servicio (lógica del ERP).
  for v_rec in select key, value from jsonb_each_text(v_services) loop
    for v_svc in
      select g.occurrence_id, g.occurrence_period
      from public.generate_recurring_service_occurrences_since_start(v_rec.value::uuid, (p->>'backfill_until')::date) g
    loop
      perform pg_temp.imp_log(p_pass, 'Servicios', null, 'cycle', v_rec.key || ' ' || to_char(v_svc.occurrence_period, 'YYYY-MM'),
        'created', v_svc.occurrence_id, jsonb_build_object('origin', 'backfill'), null);
    end loop;
  end loop;

  -- 7. Gastos (solo tipo proyecto: costo directo del PRY) -----------------
  for e in select jsonb_array_elements(p->'expenses') loop
    if e->>'type' <> 'proyecto' then
      raise exception 'IMPORT_ABORT: tipo de gasto % no implementado', e->>'type';
    end if;
    v_project := (v_projects->>(e->>'ref'))::uuid;
    v_id2 := case when coalesce(e->>'supplier', '') <> '' then (v_suppliers->>(e->>'supplier'))::uuid end;
    select d.id into v_id from public.cost_documents d
    where d.company_id = v_company and d.document_date = (e->>'date')::date
      and d.total_amount = (e->>'total')::numeric and d.currency = e->>'currency'
      and d.project_id is not distinct from v_project and d.supplier_id is not distinct from v_id2
      and exists (select 1 from public.cost_lines cl where cl.cost_document_id = d.id
                  and coalesce(cl.description, '') = coalesce(e->>'description', ''))
    limit 1;
    if v_id is not null then
      perform pg_temp.imp_log(p_pass, 'Gastos', (e->>'row')::int, 'cost_document', e->>'ref', 'skipped', v_id,
        jsonb_build_object('match', 'ya existe (proyecto, proveedor, fecha, total, descripción)'), e->'raw');
    else
      insert into public.cost_documents (
        company_id, supplier_id, project_id, classification, document_date, currency,
        net_amount, tax_amount, total_amount, recognized_period, status, source
      ) values (
        v_company, v_id2, v_project, 'direct', (e->>'date')::date, e->>'currency',
        (e->>'net')::numeric, (e->>'tax')::numeric, (e->>'total')::numeric,
        (e->>'period')::date, 'confirmed', 'import'
      ) returning id into v_id;
      insert into public.cost_lines (cost_document_id, description, amount)
      values (v_id, nullif(e->>'description', ''), (e->>'net')::numeric);
      perform pg_temp.imp_log(p_pass, 'Gastos', (e->>'row')::int, 'cost_document', e->>'ref', 'created', v_id,
        jsonb_build_object('number', e->>'number'), e->'raw');
    end if;
  end loop;

  -- 8. Registro en import_batches / import_rows (solo si hubo cambios) ---
  if exists (select 1 from _imp_log where pass = p_pass and action in ('created', 'updated', 'adopted', 'linked')) then
    insert into public.import_batches (
      company_id, file_name, total_rows, imported_rows, updated_rows, unchanged_rows, review_rows, oldest_document_date
    )
    select v_company, p->>'batch_file_name', (p->>'excel_rows')::int,
      count(*) filter (where action = 'created'),
      count(*) filter (where action in ('updated', 'adopted', 'linked')),
      count(*) filter (where action = 'skipped'),
      count(*) filter (where action = 'warning'),
      (p->>'oldest_date')::date
    from _imp_log where pass = p_pass
    returning id into v_batch;
    insert into public.import_rows (import_batch_id, row_number, raw_data, status, error_message, sales_document_id)
    select v_batch, coalesce(row_no, 0),
      jsonb_build_object('seq', seq, 'sheet', sheet, 'entity', entity, 'ref', ref, 'action', action,
        'entity_id', entity_id, 'detail', detail, 'source', raw),
      case action when 'created' then 'imported' when 'skipped' then 'unchanged' when 'warning' then 'review' else 'updated' end,
      case when action = 'warning' then detail->>'message' end,
      case when entity = 'sales_document' and action = 'created' then entity_id end
    from _imp_log where pass = p_pass order by seq;
    update public.sales_documents d set import_row_id = ir.id
    from public.import_rows ir
    where ir.import_batch_id = v_batch and ir.sales_document_id = d.id;
  end if;
end;
$f$;

-- Deshace lo que registró este import (dev): orden inverso al de creación.
create function pg_temp.imp_cleanup(p_company_name text) returns int language plpgsql as $f$
declare
  v_company uuid := pg_temp.imp_company(p_company_name);
  r record;
  v_id uuid;
  v_n int := 0;
begin
  for r in
    select ir.raw_data as d
    from public.import_rows ir
    join public.import_batches ib on ib.id = ir.import_batch_id
    where ib.company_id = v_company and ib.file_name like 'import-uy-2026:%'
    order by ib.imported_at desc, (ir.raw_data->>'seq')::int desc
  loop
    v_id := (r.d->>'entity_id')::uuid;
    continue when v_id is null or r.d->>'action' in ('skipped', 'warning');
    v_n := v_n + 1;
    case r.d->>'entity' || ':' || (r.d->>'action')
      when 'service:adopted' then
        update public.recurring_services
        set price = (r.d->'detail'->'before'->>'price')::numeric,
            uses_cost_pool = (r.d->'detail'->'before'->>'uses_cost_pool')::boolean,
            fixed_monthly_cost = (r.d->'detail'->'before'->>'fixed_monthly_cost')::numeric,
            start_date = (r.d->'detail'->'before'->>'start_date')::date
        where id = v_id and r.d->'detail' ? 'before';
      when 'cycle:linked' then
        -- El trigger de tipo de cambio conserva el que el ciclo ya tenga.
        update public.recurring_service_occurrences
        set sales_document_id = null,
            status = r.d->'detail'->'before'->>'status',
            invoiced_at = (r.d->'detail'->'before'->>'invoiced_at')::date,
            collected_at = (r.d->'detail'->'before'->>'collected_at')::date,
            link_review = r.d->'detail'->'before'->>'link_review',
            amount = (r.d->'detail'->'before'->>'amount')::numeric
        where id = v_id;
      when 'cycle:created' then
        delete from public.recurring_service_occurrences where id = v_id;
      when 'cost_document:created' then
        delete from public.cost_allocations where cost_document_id = v_id;
        delete from public.cost_lines where cost_document_id = v_id;
        delete from public.cost_documents where id = v_id;
      when 'sales_document:created' then
        update public.recurring_service_occurrences set sales_document_id = null where sales_document_id = v_id;
        update public.sales_documents set import_row_id = null where id = v_id;
        update public.import_rows set sales_document_id = null where sales_document_id = v_id;
        delete from public.sales_lines where sales_document_id = v_id;
        delete from public.sales_documents where id = v_id;
      when 'project_quote:created' then
        delete from public.project_quotes where id = v_id;
      when 'project:created' then
        delete from public.project_notes where project_id = v_id;
        delete from public.projects where id = v_id;
      when 'service:created' then
        delete from public.recurring_service_occurrences where recurring_service_id = v_id;
        delete from public.recurring_services where id = v_id;
      when 'supplier:created' then
        delete from public.suppliers where id = v_id;
      when 'client_alias:created' then
        delete from public.client_aliases where id = v_id;
      when 'client:created' then
        delete from public.clients where id = v_id;
      when 'client:updated' then
        update public.clients
        set tax_id = r.d->'detail'->'before'->>'tax_id', notes = r.d->'detail'->'before'->>'notes'
        where id = v_id;
      when 'area:created' then
        delete from public.business_areas where id = v_id;
      else
        raise exception 'cleanup: acción desconocida %', r.d->>'entity' || ':' || (r.d->>'action');
    end case;
  end loop;
  delete from public.import_rows where import_batch_id in (
    select id from public.import_batches where company_id = v_company and file_name like 'import-uy-2026:%');
  delete from public.import_batches where company_id = v_company and file_name like 'import-uy-2026:%';
  return v_n;
end;
$f$;

create function pg_temp.imp_counts(p_schema text, p_tables text[]) returns jsonb language plpgsql as $f$
declare
  t text;
  n bigint;
  out jsonb := '{}';
begin
  foreach t in array p_tables loop
    execute format('select count(*) from %I.%I', p_schema, t) into n;
    out := out || jsonb_build_object(t, n);
  end loop;
  return out;
end;
$f$;

create function pg_temp.imp_backup(p_schema text, p_tables text[]) returns jsonb language plpgsql as $f$
declare
  t text;
begin
  execute format('create schema %I', p_schema);
  foreach t in array p_tables loop
    execute format('create table %I.%I as select * from public.%I', p_schema, t, t);
  end loop;
  return pg_temp.imp_counts(p_schema, p_tables);
end;
$f$;

-- Deja cada tabla igual que su copia en el schema de backup. Se llama con
-- session_replication_role = replica (SET LOCAL en el script, no se puede desde
-- una función): sin triggers ni FKs, porque el backup es una foto consistente.
create function pg_temp.imp_restore(p_schema text, p_tables text[]) returns jsonb language plpgsql as $f$
declare
  t text;
  v_cols text;
  v_bcols text;
  v_xcols text;
  i int;
begin
  if current_setting('session_replication_role') <> 'replica' then
    raise exception 'IMPORT_ABORT: imp_restore requiere session_replication_role = replica';
  end if;
  for i in reverse array_length(p_tables, 1)..1 loop
    t := p_tables[i];
    execute format('delete from public.%I x where not exists (select 1 from %I.%I b where b.id = x.id)', t, p_schema, t);
  end loop;
  foreach t in array p_tables loop
    select string_agg(format('%I', column_name), ', ' order by ordinal_position),
           string_agg('b.' || format('%I', column_name), ', ' order by ordinal_position),
           string_agg('x.' || format('%I', column_name), ', ' order by ordinal_position)
    into v_cols, v_bcols, v_xcols
    from information_schema.columns where table_schema = p_schema and table_name = t;
    execute format('update public.%1$I x set (%3$s) = (select %4$s from %2$I.%1$I b where b.id = x.id) '
      'where exists (select 1 from %2$I.%1$I b where b.id = x.id and row(%4$s) is distinct from row(%5$s))',
      t, p_schema, v_cols, v_bcols, v_xcols);
    execute format('insert into public.%1$I (%3$s) select %3$s from %2$I.%1$I b where not exists (select 1 from public.%1$I x where x.id = b.id)',
      t, p_schema, v_cols);
  end loop;
  return pg_temp.imp_counts('public', p_tables);
end;
$f$;

-- Verificaciones de la consigna (solo lectura).
create function pg_temp.imp_checks(p jsonb) returns table (name text, ok boolean, detail text)
language plpgsql as $f$
declare
  v_company uuid := pg_temp.imp_company(p->>'company_name');
  v_svc uuid;
  v_ref text;
  v_txt text;
  v_n int;
  v_m int;
  v_rec record;
  v_cur text;
  v_net numeric;
  v_total numeric;
  v_first date;
  v_last date;
begin
  -- Documentos de venta
  select count(*), count(*) filter (where source = 'import') into v_n, v_m
  from public.sales_documents
  where company_id = v_company and document_type = 'invoice'
    and document_number in (select jsonb_array_elements_text(p->'expected'->'numbers'));
  name := 'ventas: documentos'; ok := v_n = (p->'expected'->>'documents')::int;
  detail := format('%s documentos (%s con origen import), se esperaban %s', v_n, v_m, p->'expected'->>'documents');
  return next;

  select count(*) into v_n from public.sales_lines sl join public.sales_documents d on d.id = sl.sales_document_id
  where d.company_id = v_company and d.document_type = 'invoice'
    and d.document_number in (select jsonb_array_elements_text(p->'expected'->'numbers'));
  name := 'ventas: líneas'; ok := v_n = (p->'expected'->>'lines')::int;
  detail := format('%s líneas, se esperaban %s', v_n, p->'expected'->>'lines');
  return next;

  for v_cur in select jsonb_object_keys(p->'expected'->'net') loop
    select coalesce(sum(net_amount), 0), coalesce(sum(total_amount), 0) into v_net, v_total
    from public.sales_documents
    where company_id = v_company and document_type = 'invoice' and currency = v_cur
      and document_number in (select jsonb_array_elements_text(p->'expected'->'numbers'));
    name := 'ventas: neto y total ' || v_cur;
    ok := v_net = (p->'expected'->'net'->>v_cur)::numeric and v_total = (p->'expected'->'total'->>v_cur)::numeric;
    detail := format('neto %s / total %s (esperado %s / %s)', v_net, v_total, p->'expected'->'net'->>v_cur, p->'expected'->'total'->>v_cur);
    return next;
  end loop;

  -- Ciclos por servicio: períodos facturados -> cobrados y vinculados; el resto
  -- hasta el último período generado -> pendientes; ningún mes faltante.
  for v_ref in select jsonb_array_elements_text(p->'expected'->'service_refs') loop
    v_svc := pg_temp.imp_registry(v_company, 'service', v_ref);
    if v_svc is null then
      name := 'ciclos ' || v_ref; ok := false; detail := 'servicio no encontrado en el registro del import'; return next;
      continue;
    end if;
    select min(period), max(period) into v_first, v_last
    from public.recurring_service_occurrences where recurring_service_id = v_svc;
    select count(*) into v_n
    from jsonb_array_elements_text(p->'expected'->'invoiced_periods'->v_ref) per
    where not exists (
      select 1 from public.recurring_service_occurrences o
      join public.sales_documents d on d.id = o.sales_document_id
      where o.recurring_service_id = v_svc and o.period = per::date and o.status = 'collected'
        and d.company_id = v_company and d.document_number in (select jsonb_array_elements_text(p->'expected'->'numbers'))
    );
    select string_agg(to_char(o.period, 'YYYY-MM') || '=' || o.status, ', ' order by o.period) into v_txt
    from public.recurring_service_occurrences o where o.recurring_service_id = v_svc;
    name := 'ciclos ' || v_ref || ': períodos facturados cobrados';
    ok := v_n = 0;
    detail := format('%s períodos facturados sin ciclo cobrado/vinculado; ciclos: %s', v_n, v_txt);
    return next;

    select count(*) into v_n
    from public.recurring_service_occurrences o
    where o.recurring_service_id = v_svc and o.sales_document_id is null
      and o.period <= date '2026-10-01'
      and o.status not in ('pending_invoice', 'pending_collection');
    select count(*) into v_m
    from generate_series(v_first, v_last, interval '1 month') g
    where not exists (select 1 from public.recurring_service_occurrences o where o.recurring_service_id = v_svc and o.period = g::date);
    name := 'ciclos ' || v_ref || ': meses sin factura pendientes, sin huecos';
    ok := v_n = 0 and v_m = 0;
    detail := format('%s ciclos sin factura que no están pendientes; %s meses faltantes entre %s y %s; pendientes: %s',
      v_n, v_m, v_first, v_last,
      coalesce((select string_agg(to_char(o.period, 'YYYY-MM'), ', ' order by o.period) from public.recurring_service_occurrences o
        where o.recurring_service_id = v_svc and o.sales_document_id is null), 'ninguno'));
    return next;
  end loop;

  -- Proyectos: venta vinculada, costo directo y margen
  for v_rec in select key, value from jsonb_each_text(p->'expected'->'margins') loop
    v_svc := pg_temp.imp_registry(v_company, 'project', v_rec.key);
    select coalesce(sum(net_amount), 0), count(*) into v_net, v_n from public.sales_documents
    where project_id = v_svc and not voided;
    select coalesce(sum(cd.net_amount), 0), count(*) into v_total, v_m from public.cost_documents cd
    where cd.project_id = v_svc and cd.classification = 'direct' and public.covered_by_cost_pool_id(cd) is null;
    name := 'proyecto ' || v_rec.key || ': venta, costo y margen';
    ok := v_svc is not null and v_n >= 1 and v_m >= 1 and v_net - v_total = v_rec.value::numeric;
    detail := format('%s venta(s) neto %s, %s costo(s) directo(s) %s, margen %s (esperado %s)', v_n, v_net, v_m, v_total, v_net - v_total, v_rec.value);
    return next;
  end loop;

  -- Clientes sin duplicar
  select count(*) into v_n from (
    select pg_temp.imp_norm(c.name) from public.clients c where c.company_id = v_company
    group by 1 having count(*) > 1) x;
  select count(*) into v_m from (
    select regexp_replace(c.tax_id, '\D', '', 'g') from public.clients c
    where c.company_id = v_company and coalesce(btrim(c.tax_id), '') <> ''
    group by 1 having count(*) > 1) x;
  name := 'clientes sin duplicar'; ok := v_n = 0 and v_m = 0;
  detail := format('%s nombres y %s RUT repetidos en la empresa', v_n, v_m);
  return next;

  -- Ninguna venta ni costo de 2026 sin tipo de cambio (quedaría sin convertir)
  select string_agg(distinct to_char(d, 'YYYY-MM'), ', ') into v_txt from (
    select document_date as d from public.sales_documents
    where company_id = v_company and not voided and exchange_rate is null and document_date >= date '2025-12-01'
    union all
    select document_date from public.cost_documents
    where company_id = v_company and exchange_rate is null and document_date >= date '2025-12-01'
  ) x;
  name := 'documentos sin tipo de cambio (desde 2025-12)'; ok := v_txt is null; detail := coalesce(v_txt, 'ninguno');
  return next;

  -- Ciclos anteriores a 2025-12 sin factura (se dejan como están)
  select string_agg(s.name || ' ' || to_char(o.period, 'YYYY-MM') || '=' || o.status, ', ' order by s.name, o.period) into v_txt
  from public.recurring_service_occurrences o
  join public.recurring_services s on s.id = o.recurring_service_id
  where s.company_id = v_company and o.period < date '2025-12-01' and o.sales_document_id is null;
  name := 'info: ciclos anteriores a 2025-12 sin factura'; ok := true; detail := coalesce(v_txt, 'ninguno');
  return next;

  -- Resultado mensual por SQL (ene-oct 2026), en moneda de la empresa
  for v_rec in
    select m::date as month,
      (select coalesce(sum(d.net_amount * d.exchange_rate), 0) from public.sales_documents d
       where d.company_id = v_company and not d.voided and d.document_type <> 'credit_note'
         and coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) = m::date) as sales,
      (select count(*) from public.sales_documents d
       where d.company_id = v_company and not d.voided and d.exchange_rate is null
         and coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) = m::date) as pending,
      (select coalesce(sum(c.net_amount * c.exchange_rate), 0) from public.cost_documents c
       where c.company_id = v_company and c.classification = 'direct'
         and coalesce(c.recognized_period, date_trunc('month', c.document_date)::date) = m::date) as costs
    from generate_series(date '2026-01-01', date '2026-10-01', interval '1 month') m
  loop
    name := 'info: resultado ' || to_char(v_rec.month, 'YYYY-MM'); ok := true;
    detail := format('ventas %s UYU, costos directos %s UYU, %s documento(s) sin cotización', round(v_rec.sales, 2), round(v_rec.costs, 2), v_rec.pending);
    return next;
  end loop;
end;
$f$;
`;

function dollarTag(text) {
  let tag;
  do tag = `imp${randomBytes(4).toString('hex')}`; while (text.includes(`$${tag}$`));
  return `$${tag}$`;
}

const jsonLiteral = (obj) => {
  const s = JSON.stringify(obj);
  const tag = dollarTag(s);
  return `${tag}${s}${tag}::jsonb`;
};

const LOG_SELECT = `select 'log' as kind, seq, pass, sheet, row_no, entity, ref, action, entity_id::text as entity_id, detail from _imp_log`;
const CHECK_SELECT = `select 'check' as kind, null::int as seq, null::int as pass, null::text as sheet, null::int as row_no, 'check' as entity, name as ref, case when ok then 'ok' else 'FAIL' end as action, null::text as entity_id, jsonb_build_object('detail', detail) as detail from _imp_checks`;

const tablesArray = `array[${TOUCHED_TABLES.map((t) => `'${t}'`).join(', ')}]`;

function importSql(payload, { commit }) {
  return [
    'begin;',
    SQL_FUNCTIONS,
    `create temp table _imp_payload on commit drop as select ${jsonLiteral(payload)} as p;`,
    'select pg_temp.imp_run((select p from _imp_payload), 1);',
    `${LOG_SELECT} order by seq;`,
    commit ? 'commit;' : 'rollback;',
  ].join('\n');
}

function checksSql(payload) {
  return [
    'begin;',
    SQL_FUNCTIONS,
    `insert into _imp_checks select * from pg_temp.imp_checks(${jsonLiteral(payload)});`,
    `${CHECK_SELECT};`,
    'rollback;',
  ].join('\n');
}

function simulateSql(payload, fixture, mode) {
  const steps = [
    'begin;',
    fixture,
    SQL_FUNCTIONS,
    `create temp table _imp_payload on commit drop as select ${jsonLiteral(payload)} as p;`,
    `create temp table _imp_base on commit drop as select pg_temp.imp_counts('public', ${tablesArray}) as c;`,
  ];
  if (mode === 'restore') steps.push(`select pg_temp.imp_backup('${BACKUP_SCHEMA}', ${tablesArray});`);
  steps.push(
    'select pg_temp.imp_run((select p from _imp_payload), 1);',
    'select pg_temp.imp_run((select p from _imp_payload), 2);',
    'insert into _imp_checks select * from pg_temp.imp_checks((select p from _imp_payload));',
    `insert into _imp_checks select 're-ejecución sin inserciones', count(*) = 0, count(*) || ' cambios en la segunda pasada' from _imp_log where pass = 2 and action in ('created', 'updated', 'adopted', 'linked');`,
  );
  if (mode === 'restore') {
    steps.push(
      'set local session_replication_role = replica;',
      `insert into _imp_checks select 'restore desde backup deja los conteos previos', r = (select c from _imp_base), r::text from (select pg_temp.imp_restore('${BACKUP_SCHEMA}', ${tablesArray}) as r) x;`,
      'set local session_replication_role = origin;',
      `insert into _imp_checks select 'restore: filas idénticas al backup', count(*) = 0, count(*) || ' clientes/ciclos distintos' from (
         (select id, tax_id, notes, updated_at from public.clients except select id, tax_id, notes, updated_at from ${BACKUP_SCHEMA}.clients)
         union all
         (select id, null, status || coalesce(sales_document_id::text, '') || amount, updated_at from public.recurring_service_occurrences
          except select id, null, status || coalesce(sales_document_id::text, '') || amount, updated_at from ${BACKUP_SCHEMA}.recurring_service_occurrences)) x;`,
    );
  } else {
    steps.push(
      `insert into _imp_checks select 'cleanup por import_batches', true, pg_temp.imp_cleanup((select p->>'company_name' from _imp_payload)) || ' entidades deshechas';`,
      `insert into _imp_checks select 'cleanup deja los conteos previos', c = (select c from _imp_base), c::text from (select pg_temp.imp_counts('public', ${tablesArray}) as c) x;`,
    );
  }
  steps.push(`${LOG_SELECT} union all ${CHECK_SELECT};`, 'rollback;');
  return steps.join('\n');
}

// ---------------------------------------------------------------------------
// Ejecución contra Supabase (Management API vía CLI)
// ---------------------------------------------------------------------------
function cli(args) {
  const res = spawnSync('npx', ['supabase', ...args], {
    cwd: WEB_DIR, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: '' },
  });
  return res;
}

let tmpCounter = 0;
function runSql(target, sql, label) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `.sql-${process.pid}-${tmpCounter++}.sql`);
  writeFileSync(file, sql);
  const res = cli(['db', 'query', '--linked', '--project-ref', TARGETS[target].ref, '--output-format', 'json', '-f', `"${file}"`]);
  rmSync(file, { force: true }); // no deja el SQL (con datos) en disco
  const out = res.stdout || '';
  const start = out.indexOf('{');
  if (res.status !== 0 || start < 0) {
    const err = (res.stderr || '').split('\n').filter((x) => !/new version|recommend|getting-started|Initialising/.test(x)).join('\n');
    const abort = /IMPORT_ABORT: ([^\n]+)/.exec((err + out).replace(/\\+"/g, '"'));
    const reason = abort ? abort[1].split(/\\+n|\s*\(SQLSTATE/)[0] : (err || out).slice(0, 2000);
    throw new Error(`${label}: ${reason}`);
  }
  const json = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
  return json.rows || [];
}

function verifyTarget(target) {
  const res = cli(['projects', 'list', '-o', 'json']);
  const start = (res.stdout || '').indexOf('[');
  if (res.status !== 0 || start < 0) fail('no se pudo listar los proyectos de Supabase para confirmar el destino');
  const projects = JSON.parse(res.stdout.slice(start));
  const t = TARGETS[target];
  const p = projects.find((x) => (x.ref || x.id) === t.ref);
  if (!p || p.name !== t.name) fail(`el ref ${t.ref} no corresponde a ${t.name}`);
  console.log(`Destino confirmado: ${p.name} (ref ${t.ref}, región ${p.region}) vía Management API`);
}

const SCHEMA_SQL = (tables) => `
select 'col' k, table_name t, column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') d
from information_schema.columns where table_schema = 'public' and table_name in (${tables})
union all select 'con', conrelid::regclass::text, conname || ' ' || pg_get_constraintdef(oid)
from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text in (${tables})
union all select 'idx', tablename, indexdef from pg_indexes where schemaname = 'public' and tablename in (${tables})
union all select 'trg', tgrelid::regclass::text, pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgrelid::regclass::text in (${tables})
union all select 'fn', p.proname, md5(regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g'))
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
order by 1, 2, 3;`;

function schemaDiff() {
  const tables = SCHEMA_TABLES.map((t) => `'${t}'`).join(', ');
  const fp = (target) => new Set(runSql(target, SCHEMA_SQL(tables), `esquema ${target}`).map((r) => `${r.k} ${r.t} ${r.d}`));
  const dev = fp('dev');
  const prod = fp('prod');
  return [...[...dev].filter((x) => !prod.has(x)).map((x) => `solo dev:  ${x}`), ...[...prod].filter((x) => !dev.has(x)).map((x) => `solo prod: ${x}`)];
}

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------
function summarize(rows) {
  const counts = {};
  for (const r of rows.filter((x) => x.kind === 'log')) {
    const k = `${r.entity}:${r.action}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function printLog(rows) {
  const label = { created: 'crear', updated: 'actualizar', adopted: 'adoptar (ya existía)', linked: 'vincular', skipped: 'omitida (ya existe)', warning: 'advertencia' };
  const logRows = rows.filter((x) => x.kind === 'log').sort((a, b) => a.pass - b.pass || a.seq - b.seq);
  for (const r of logRows) {
    const det = r.detail ? ` ${JSON.stringify(r.detail)}` : '';
    console.log(`  [${r.pass}] ${r.sheet ?? ''}${r.row_no ? ` fila ${r.row_no}` : ''} ${r.entity} ${r.ref ?? ''} -> ${label[r.action] ?? r.action}${det}`);
  }
}

function printChecks(rows) {
  let failed = 0;
  for (const r of rows.filter((x) => x.kind === 'check')) {
    if (r.action === 'FAIL') failed++;
    console.log(`  ${r.action === 'ok' ? 'OK  ' : 'FAIL'} ${r.ref}: ${r.detail?.detail ?? ''}`);
  }
  return failed;
}

function saveSummary(name, data) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// Cantidades que tienen que coincidir entre dev y prod; el resto (áreas,
// clientes, alias, proveedores, servicios adoptados) puede diferir si en una
// base ya existían.
const MUST_MATCH = ['sales_document', 'cycle', 'cost_document', 'project', 'project_quote'];

function compareWithDev(prodCounts) {
  const file = path.join(OUT_DIR, 'dev-dry-run.json');
  if (!existsSync(file)) fail('no hay dry-run de dev para comparar (data/import/out/dev-dry-run.json)');
  const devCounts = JSON.parse(readFileSync(file, 'utf8')).counts;
  const keys = [...new Set([...Object.keys(devCounts), ...Object.keys(prodCounts)])].sort();
  const diffs = keys.filter((k) => (devCounts[k] ?? 0) !== (prodCounts[k] ?? 0));
  console.log('\nComparación dry-run dev vs prod:');
  for (const k of keys) console.log(`  ${k.padEnd(28)} dev ${String(devCounts[k] ?? 0).padStart(3)}  prod ${String(prodCounts[k] ?? 0).padStart(3)}${diffs.includes(k) ? '  <-- difiere' : ''}`);
  const blocking = diffs.filter((k) => MUST_MATCH.includes(k.split(':')[0]) && !k.endsWith(':skipped') && !k.endsWith(':linked'));
  return { diffs, blocking };
}

// ---------------------------------------------------------------------------
// Tipo de cambio histórico (exchange_rate_snapshots, mismo formato que
// web/src/lib/exchangeRates.ts: ARS por unidad y ARS por USD, punto medio
// compra/venta). Un snapshot por mes, al último día hábil del mes según BCU.
//   ars_per_usd  : MonedAPI usd/oficial de ese día (histórico /api/v2/date/...).
//   ars_per_unit : MonedAPI uyu/oficial de ese día si lo tiene; si no,
//                  ars_per_usd / BCU interbancario (moneda 2225) de ese día.
// ---------------------------------------------------------------------------
const FX_MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const FX_HEADER = 'currency,period,ars_per_unit,ars_per_usd,quote_date,source,uyu_per_usd,bcu_uyu_per_usd';

async function bcuQuotes(from, to) {
  const body = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza"><soapenv:Header/><soapenv:Body><cot:wsbcucotizaciones.Execute><cot:Entrada><cot:Moneda><cot:item>2225</cot:item></cot:Moneda><cot:FechaDesde>${from}</cot:FechaDesde><cot:FechaHasta>${to}</cot:FechaHasta><cot:Grupo>0</cot:Grupo></cot:Entrada></cot:wsbcucotizaciones.Execute></soapenv:Body></soapenv:Envelope>`;
  const res = await fetch('https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones', {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'User-Agent': 'inma-erp-import' }, body,
  });
  const xml = await res.text();
  const quotes = new Map();
  for (const m of xml.matchAll(/<datoscotizaciones\.dato[^>]*>([\s\S]*?)<\/datoscotizaciones\.dato>/g)) {
    const date = /<Fecha>([^<]+)<\/Fecha>/.exec(m[1])?.[1];
    const code = /<Moneda>([^<]+)<\/Moneda>/.exec(m[1])?.[1];
    const tcv = Number(/<TCV>([^<]+)<\/TCV>/.exec(m[1])?.[1]);
    if (code === '2225' && date && tcv > 0) quotes.set(date, tcv);
  }
  if (!quotes.size) throw new Error(`BCU no devolvió cotizaciones (${res.status})`);
  return quotes;
}

async function monedapi(date, currency) {
  const res = await fetch(`https://monedapi.ar/api/v2/date/${date}/${currency}/oficial`, { headers: { 'User-Agent': 'inma-erp-import' } });
  if (!res.ok) throw new Error(`MonedAPI ${date} ${currency}: HTTP ${res.status}`);
  const j = await res.json();
  const ok = Number.isFinite(j.buy) && Number.isFinite(j.sell) && j.buy > 0 && j.daysStale !== null && j.daysStale <= 1;
  return ok ? { mid: (j.buy + j.sell) / 2, quotedAt: j.quotedAt } : null;
}

async function fetchFx(csvFile) {
  const bcu = await bcuQuotes(`${FX_MONTHS[0]}-01`, `${FX_MONTHS.at(-1)}-31`);
  const lines = [FX_HEADER];
  for (const month of FX_MONTHS) {
    const day = [...bcu.keys()].filter((d) => d.startsWith(month)).sort().at(-1);
    if (!day) throw new Error(`BCU sin cotización en ${month}`);
    const usd = await monedapi(day, 'usd');
    if (!usd) throw new Error(`MonedAPI sin USD oficial para ${day}`);
    const uyu = await monedapi(day, 'uyu');
    const bcuRate = bcu.get(day);
    const arsPerUnit = uyu ? uyu.mid : usd.mid / bcuRate;
    const uyuPerUsd = usd.mid / arsPerUnit;
    if (!(uyuPerUsd > 35 && uyuPerUsd < 50)) throw new Error(`${month}: UYU/USD ${uyuPerUsd} fuera de rango`);
    if (Math.abs(uyuPerUsd / bcuRate - 1) > 0.02) throw new Error(`${month}: MonedAPI (${uyuPerUsd}) y BCU (${bcuRate}) difieren más de 2%`);
    const source = uyu ? 'MonedAPI uyu/oficial + usd/oficial' : 'BCU 2225 (interbancario) + MonedAPI usd/oficial';
    lines.push([ 'UYU', `${month}-01`, arsPerUnit.toFixed(6), usd.mid.toFixed(6), day, source, uyuPerUsd.toFixed(4), bcuRate.toFixed(4)].join(','));
    console.log(`  ${month}: ${day} ARS/USD ${usd.mid.toFixed(3)} ARS/UYU ${arsPerUnit.toFixed(4)} -> UYU/USD ${uyuPerUsd.toFixed(4)} (BCU ${bcuRate}) [${source}]`);
  }
  writeFileSync(csvFile, `${lines.join('\n')}\n`);
  console.log(`Escrito ${csvFile}`);
}

function readFxCsv(csvFile) {
  const [header, ...rows] = readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  const cols = header.split(',');
  for (const c of ['currency', 'period', 'ars_per_unit', 'ars_per_usd']) if (!cols.includes(c)) fail(`el CSV no tiene la columna ${c}`);
  return rows.map((line) => Object.fromEntries(line.split(',').map((v, i) => [cols[i], v.trim()]))).map((r) => {
    if (!['UYU', 'CLP'].includes(r.currency) || !/^\d{4}-\d{2}-01$/.test(r.period) || !(Number(r.ars_per_unit) > 0) || !(Number(r.ars_per_usd) > 0)) {
      fail(`fila de tipo de cambio inválida: ${JSON.stringify(r)}`);
    }
    return r;
  });
}

// Inserta sin pisar: los snapshots ya existentes (p. ej. 2026-09 y 2026-10) quedan como están.
function loadFxSql(rows) {
  const values = rows.map((r) => `('${r.currency}', date '${r.period}', ${Number(r.ars_per_unit)}, ${Number(r.ars_per_usd)}, ${r.quote_date ? `(date '${r.quote_date}' + time '18:00') at time zone 'America/Montevideo'` : 'now()'})`).join(',\n  ');
  return `begin;
with ins as (
  insert into public.exchange_rate_snapshots (currency, period, ars_per_unit, ars_per_usd, fetched_at)
  values
  ${values}
  on conflict (currency, period) do nothing
  returning currency, period
)
select 'inserted' as k, currency, period::text as period from ins
union all
select 'existing', currency, period::text from public.exchange_rate_snapshots
where (currency, period) in (${rows.map((r) => `('${r.currency}', date '${r.period}')`).join(', ')})
  and (currency, period) not in (select currency, period from ins);
commit;`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['fetch-fx']) {
    const csv = path.resolve(REPO_DIR, args['fetch-fx'] === true ? 'data/import/tipos_cambio_2026.csv' : args['fetch-fx']);
    console.log('Tipo de cambio histórico (BCU + MonedAPI):');
    await fetchFx(csv);
    return;
  }
  if (args['schema-check']) {
    verifyTarget('dev');
    verifyTarget('prod');
    const diff = schemaDiff();
    for (const d of diff) console.log(`  ${d}`);
    console.log(diff.length ? `\nESQUEMA DISTINTO: ${diff.length} diferencias` : '\nEsquema dev = prod en las tablas del import (columnas, constraints, índices, triggers, funciones)');
    process.exit(diff.length ? 1 : 0);
  }
  const target = args.target;
  if (!TARGETS[target]) fail('--target=dev|prod es obligatorio');

  if (args['load-fx']) {
    const csv = path.resolve(REPO_DIR, args['load-fx'] === true ? 'data/import/tipos_cambio_2026.csv' : args['load-fx']);
    const rows = readFxCsv(csv);
    verifyTarget(target);
    const res = runSql(target, loadFxSql(rows), 'tipo de cambio');
    for (const r of res) console.log(`  ${r.k === 'inserted' ? 'cargado ' : 'ya existía (no se pisa)'} ${r.currency} ${r.period}`);
    return;
  }
  const file = path.resolve(REPO_DIR, args.file || 'data/import/Plantilla_Importacion_UY_2026.xlsx');
  if (!existsSync(file)) fail(`no existe el archivo ${file}`);

  console.log(`Archivo: ${file} (sha256 ${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)}…)`);
  const { payload, critical, warnings, skipped, totals } = buildPayload(file);

  console.log('\n== Fase 1: validación del Excel');
  console.log(`Documentos de venta: ${totals.documents}; neto ${JSON.stringify(totals.net)}; total ${JSON.stringify(totals.total)}`);
  console.log(`Esperado:            ${EXPECTED.documents}; neto ${JSON.stringify(EXPECTED.net)}; total ${JSON.stringify(EXPECTED.total)}`);
  for (const s of skipped) console.log(`  OMITIDA: ${s}`);
  for (const w of warnings) console.log(`  ADVERTENCIA: ${w}`);
  for (const c of critical) console.log(`  CRÍTICO: ${c}`);
  if (critical.length) fail(`${critical.length} error(es) crítico(s) en el Excel; no se escribió nada`);
  console.log('Validación OK');

  if (args.validate) return;

  console.log(`\n== Base: ${target}`);
  verifyTarget(target);

  if (args.verify) {
    const rows = runSql(target, checksSql(payload), 'verificación');
    const failed = printChecks(rows);
    process.exit(failed ? 1 : 0);
  }

  if (args.simulate) {
    if (target !== 'dev') fail('--simulate solo corre contra dev');
    if (!args.fixture || !existsSync(args.fixture)) fail('--simulate requiere --fixture=<sql>');
    const mode = args.simulate === 'restore' ? 'restore' : 'cleanup';
    console.log(`Simulación (${mode}) en una transacción con ROLLBACK: fixture + import + re-import + verificaciones + ${mode}`);
    const rows = runSql(target, simulateSql(payload, readFileSync(args.fixture, 'utf8'), mode), 'simulación');
    console.log('\nAcciones:');
    printLog(rows);
    const counts = summarize(rows.filter((r) => r.pass === 1));
    console.log('\nResumen pasada 1:', counts);
    console.log('Resumen pasada 2:', summarize(rows.filter((r) => r.pass === 2)));
    console.log('\nVerificaciones:');
    const failed = printChecks(rows);
    saveSummary(`dev-simulate-${mode}`, { counts, rows });
    process.exit(failed ? 1 : 0);
  }

  if (args.cleanup) {
    if (target !== 'dev') fail('--cleanup solo corre contra dev; en prod se restaura desde el backup');
    const rows = runSql(target, ['begin;', SQL_FUNCTIONS,
      `select pg_temp.imp_cleanup('${COMPANY_NAME}') as n;`, 'commit;'].join('\n'), 'cleanup');
    console.log(`Cleanup: ${rows[0]?.n} entidades deshechas`);
    return;
  }

  if (args.restore) {
    if (target !== 'prod') fail('--restore es para prod (en dev se usa --cleanup)');
    const rows = runSql(target, ['begin;', SQL_FUNCTIONS, 'set local session_replication_role = replica;',
      `select pg_temp.imp_restore('${String(args.restore).replace(/[^a-z0-9_]/g, '')}', ${tablesArray}) as counts;`, 'commit;'].join('\n'), 'restore');
    console.log('Conteos tras restaurar:', rows[0]?.counts);
    return;
  }

  if (target === 'prod') {
    const diff = schemaDiff();
    if (diff.length) {
      console.log('\nEl esquema de prod difiere del de dev en las tablas del import:');
      for (const d of diff) console.log(`  ${d}`);
      if (!args['allow-schema-diff']) fail('esquema distinto entre dev y prod (usar --allow-schema-diff solo después de revisarlo)');
    } else console.log('Esquema dev = prod en las tablas del import');
    if (!args['dry-run']) {
      console.log(`\nBackup en el schema ${BACKUP_SCHEMA}...`);
      const b = runSql(target, ['begin;', SQL_FUNCTIONS,
        `select pg_temp.imp_backup('${BACKUP_SCHEMA}', ${tablesArray}) as counts;`, 'commit;'].join('\n'), 'backup');
      console.log('Conteos del backup:', b[0]?.counts);
    }
  }

  // Dry-run (siempre antes de escribir)
  const dryRows = runSql(target, importSql(payload, { commit: false }), 'dry-run');
  const dryCounts = summarize(dryRows);
  console.log(`\n== Dry-run (${target}): lo que se crearía/actualizaría/omitiría`);
  printLog(dryRows);
  console.log('\nResumen:', dryCounts);
  saveSummary(`${target}-dry-run`, { counts: dryCounts, rows: dryRows });
  if (target === 'prod') {
    const { blocking } = compareWithDev(dryCounts);
    if (blocking.length) fail(`diferencias sin explicar entre dev y prod: ${blocking.join(', ')}`);
  }
  if (args['dry-run']) return;

  // Ejecución real
  const realRows = runSql(target, importSql(payload, { commit: true }), 'ejecución');
  console.log(`\n== Ejecución real (${target}) confirmada:`, summarize(realRows));
  saveSummary(`${target}-run`, { counts: summarize(realRows), rows: realRows });

  console.log('\nVerificaciones:');
  let failed = printChecks(runSql(target, checksSql(payload), 'verificación'));
  const again = runSql(target, importSql(payload, { commit: true }), 're-ejecución');
  const changes = again.filter((r) => ['created', 'updated', 'adopted', 'linked'].includes(r.action)).length;
  console.log(`  ${changes === 0 ? 'OK  ' : 'FAIL'} re-ejecución: ${changes} cambios`);
  if (changes) failed++;

  if (failed && target === 'prod') {
    console.log(`\nFallaron ${failed} verificaciones: restaurando desde ${BACKUP_SCHEMA}...`);
    const r = runSql(target, ['begin;', SQL_FUNCTIONS, 'set local session_replication_role = replica;',
      `select pg_temp.imp_restore('${BACKUP_SCHEMA}', ${tablesArray}) = pg_temp.imp_counts('${BACKUP_SCHEMA}', ${tablesArray}) as ok;`, 'commit;'].join('\n'), 'restore');
    fail(`verificaciones fallidas; restauración ${r[0]?.ok ? 'OK (conteos iguales al backup)' : 'con conteos distintos: revisar'}`);
  }
  if (failed) fail(`${failed} verificación(es) fallida(s) en ${target}; usar --cleanup para deshacer`);
  console.log('\nTodo OK');
}

main().catch((error) => fail(error.message));
