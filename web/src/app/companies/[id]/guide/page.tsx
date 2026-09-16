import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { GuideToc } from "@/components/GuideToc";

const TOC = [
  { id: "inicio", label: "Primeros pasos" },
  { id: "flujo", label: "Cómo se arma un número" },
  { id: "conceptos", label: "Conceptos clave" },
  { id: "navegacion", label: "Ingreso y navegación" },
  { id: "empresas", label: "Empresas" },
  { id: "configuracion", label: "Configuración inicial" },
  { id: "proyectos", label: "Proyectos" },
  { id: "ventas", label: "Ventas" },
  { id: "costos", label: "Costos y gastos" },
  { id: "servicios-personal", label: "Recurrentes y personal" },
  { id: "reportes", label: "Los 4 reportes" },
  { id: "reglas", label: "Reglas de confiabilidad" },
  { id: "alcance", label: "Qué no hace (aún)" },
] as const;

function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">
          {eyebrow}
        </div>
        <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">
          {title}
        </h2>
        {lede ? (
          <p className="text-[13.5px] text-[var(--color-muted)]">{lede}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item, i) => (
        <li
          key={i}
          className="relative pl-4 text-[13.5px] leading-relaxed text-[var(--color-ink-2)] before:absolute before:left-0 before:top-[8px] before:h-[5px] before:w-[5px] before:rounded-full before:bg-[var(--color-accent)]"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function Route({ children }: { children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-md border border-[var(--color-hairline)] bg-[var(--color-row)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-2)]">
      {children}
    </span>
  );
}

function Tile({
  title,
  route,
  badge,
  children,
}: {
  title: string;
  route?: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[11px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-ink)]">
          {title}
          {badge ? <Badge variant="neutral">{badge}</Badge> : null}
        </h4>
        {route ? <Route>{route}</Route> : null}
      </div>
      <p className="text-[12.8px] leading-relaxed text-[var(--color-muted)]">{children}</p>
    </div>
  );
}

export default async function CompanyGuidePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  return (
    <div className="flex items-start gap-10">
      <div className="flex max-w-[820px] flex-1 flex-col gap-[26px] pb-16">
      <PageHeader
        eyebrow="GUÍA DE INGRESO"
        title="Todo lo que hace la app, en el orden en que lo vas a usar"
        subtitle={membership.company.name}
      />

      <p className="text-[14px] leading-relaxed text-[var(--color-ink-2)]">
        INMA ERP es la fuente de verdad del <strong className="text-[var(--color-ink)]">resultado de gestión</strong> de
        Inmasoft: cuánto se vendió, cuánto costó y cuánto quedó de margen, mes a mes, por cliente,
        proyecto y área de negocio. No maneja bancos, cobros ni facturación electrónica — eso sigue
        en otros sistemas. Esta guía queda siempre disponible acá; volvé cuando la necesites.
      </p>

      {/* table of contents -- mobile/tablet only; GuideToc takes over as a sticky rail at lg+ */}
      <Card padding="16px 18px" className="lg:hidden">
        <div className="mb-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">
          En esta página
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TOC.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="rounded-md border border-[var(--color-hairline)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] no-underline hover:border-[var(--color-accent)] hover:text-[var(--color-accent-strong)]"
            >
              {item.label}
            </a>
          ))}
        </div>
      </Card>

      <Section id="inicio" eyebrow="Primeros pasos" title="5 pasos para arrancar">
        <Card padding="4px 20px" className="flex flex-col">
          {[
            {
              h: "Iniciá sesión y elegí la empresa",
              p: (
                <>
                  En <Route>/companies</Route> elegís sobre cuál empresa vas a trabajar. Tu rol
                  (admin o miembro) puede ser distinto en cada una.
                </>
              ),
            },
            {
              h: "Revisá que estén los datos base",
              p: "Antes de cargar una venta necesitás al menos un cliente y un área de negocio activos. Si el proyecto tiene presupuesto o requiere mano de obra, también proyecto y personal.",
            },
            {
              h: "Cargá ventas y costos del mes",
              p: "Cada documento se etiqueta con cliente, proyecto y/o área — esas etiquetas son las que arman los reportes, así que vale la pena cargarlas bien.",
            },
            {
              h: "Confirmá el estado de cada proyecto activo",
              p: 'Si un proyecto no tuvo costo real ese mes, confirmalo explícitamente — si no, queda "pendiente" y el sistema avisa que el resultado puede bajar cuando se cargue.',
            },
            {
              h: "Mirá el panel de control",
              p: "Es la primera pantalla al entrar a una empresa: ventas, costos, margen y resultado del mes, con un clic hacia el detalle de cualquier cifra.",
            },
          ].map((step, i) => (
            <div
              key={step.h}
              className={`flex gap-3.5 py-3.5 ${i > 0 ? "border-t border-[var(--color-hairline-soft)]" : ""}`}
            >
              <div className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] font-mono text-[12px] font-bold text-[var(--color-accent-strong)]">
                {i + 1}
              </div>
              <div className="flex flex-col gap-0.5 pt-0.5">
                <h4 className="text-[13.5px] font-semibold text-[var(--color-ink)]">{step.h}</h4>
                <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
                  {step.p}
                </p>
              </div>
            </div>
          ))}
        </Card>
      </Section>

      <Section
        id="flujo"
        eyebrow="El modelo mental"
        title="Cómo se arma un número de resultado"
        lede="Todo lo que ves en un reporte sale de documentos cargados a mano (o importados) y etiquetados. Ningún reporte inventa ni redondea nada."
      >
        <div className="overflow-x-auto rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-5">
          <svg
            viewBox="0 0 900 210"
            className="block w-full min-w-[640px]"
            role="img"
            aria-label="Flujo: datos base y proyectos alimentan ventas y costos, que alimentan los reportes"
          >
            <defs>
              <marker
                id="guide-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--color-neutral-bar)" />
              </marker>
            </defs>

            <g fontFamily="JetBrains Mono, monospace">
              <rect x="10" y="16" width="150" height="34" rx="7" fill="var(--color-surface)" stroke="var(--color-hairline)" />
              <text x="85" y="37" textAnchor="middle" fontSize="11" fill="var(--color-ink)" fontWeight="600">Clientes</text>

              <rect x="10" y="58" width="150" height="34" rx="7" fill="var(--color-surface)" stroke="var(--color-hairline)" />
              <text x="85" y="79" textAnchor="middle" fontSize="11" fill="var(--color-ink)" fontWeight="600">Proveedores</text>

              <rect x="10" y="100" width="150" height="34" rx="7" fill="var(--color-surface)" stroke="var(--color-hairline)" />
              <text x="85" y="121" textAnchor="middle" fontSize="11" fill="var(--color-ink)" fontWeight="600">Áreas de negocio</text>

              <rect x="10" y="142" width="150" height="34" rx="7" fill="var(--color-surface)" stroke="var(--color-hairline)" />
              <text x="85" y="163" textAnchor="middle" fontSize="11" fill="var(--color-ink)" fontWeight="600">Personal</text>
            </g>
            <text x="85" y="10" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8.5" letterSpacing="0.08em" fill="var(--color-faint)">DATOS BASE</text>

            <path d="M160,33 C205,33 205,95 250,95" fill="none" stroke="var(--color-neutral-bar)" strokeWidth="1.3" markerEnd="url(#guide-arrow)" />
            <path d="M160,117 C205,117 205,105 250,105" fill="none" stroke="var(--color-neutral-bar)" strokeWidth="1.3" markerEnd="url(#guide-arrow)" />

            <rect x="250" y="80" width="150" height="34" rx="7" fill="var(--color-accent-soft)" stroke="var(--color-accent-soft-border)" />
            <text x="325" y="101" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--color-accent-strong)" fontWeight="700">Proyectos</text>
            <text x="325" y="70" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8.5" letterSpacing="0.08em" fill="var(--color-faint)">AGRUPAN TRABAJO</text>

            <path d="M160,71 C230,71 260,45 440,45" fill="none" stroke="var(--color-neutral-bar)" strokeWidth="1.3" markerEnd="url(#guide-arrow)" />
            <path d="M400,90 C440,90 440,45 490,45" fill="none" stroke="var(--color-neutral-bar)" strokeWidth="1.3" markerEnd="url(#guide-arrow)" />
            <path d="M160,159 C230,159 260,150 440,150" fill="none" stroke="var(--color-neutral-bar)" strokeWidth="1.3" markerEnd="url(#guide-arrow)" />
            <path d="M400,105 C440,105 440,150 490,150" fill="none" stroke="var(--color-neutral-bar)" strokeWidth="1.3" markerEnd="url(#guide-arrow)" />

            <rect x="490" y="28" width="150" height="34" rx="7" fill="var(--color-surface)" stroke="var(--color-hairline)" />
            <text x="565" y="49" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--color-ink)" fontWeight="600">Ventas</text>

            <rect x="490" y="133" width="150" height="34" rx="7" fill="var(--color-surface)" stroke="var(--color-hairline)" />
            <text x="565" y="154" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--color-ink)" fontWeight="600">Costos</text>
            <text x="565" y="18" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8.5" letterSpacing="0.08em" fill="var(--color-faint)">DOCUMENTOS DEL MES</text>

            <path d="M640,45 C700,45 700,97 770,97" fill="none" stroke="var(--color-accent-bright)" strokeWidth="1.5" markerEnd="url(#guide-arrow)" />
            <path d="M640,150 C700,150 700,105 770,105" fill="none" stroke="var(--color-accent-bright)" strokeWidth="1.5" markerEnd="url(#guide-arrow)" />

            <rect x="770" y="80" width="120" height="42" rx="8" fill="var(--color-accent)" stroke="var(--color-accent-strong)" />
            <text x="830" y="97" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="10.5" fill="var(--color-on-accent)" fontWeight="700">Reportes</text>
            <text x="830" y="111" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8" fill="var(--color-on-accent)">resultado, margen</text>
          </svg>
        </div>
        <Bullets
          items={[
            <>
              <strong className="text-[var(--color-ink)]">Ventas netas</strong> es siempre sin IVA
              — el impuesto se guarda pero nunca cuenta como ganancia.
            </>,
            <>
              Un costo es <strong className="text-[var(--color-ink)]">directo</strong> (de un
              proyecto puntual) o <strong className="text-[var(--color-ink)]">general</strong>{" "}
              (estructura de la empresa).
            </>,
            <>
              Un mismo costo se puede repartir entre varios proyectos/clientes/áreas — eso es una{" "}
              <strong className="text-[var(--color-ink)]">asignación de costo</strong>.
            </>,
          ]}
        />
      </Section>

      <Section
        id="conceptos"
        eyebrow="Vocabulario"
        title="Conceptos clave"
        lede="Aparecen en todas las pantallas de reportes — entenderlos es la base para leer cualquier número del sistema."
      >
        <TableCard>
          <thead>
            <tr>
              <Th>Término</Th>
              <Th>Qué significa</Th>
            </tr>
          </thead>
          <tbody>
            <Tr>
              <Td className="whitespace-nowrap font-medium text-[var(--color-ink)]">Margen directo</Td>
              <Td>Ventas netas − costos directos.</Td>
            </Tr>
            <Tr>
              <Td className="whitespace-nowrap font-medium text-[var(--color-ink)]">Resultado operativo</Td>
              <Td>
                Margen directo − costos generales del período. Es el número principal de &quot;cuánto
                ganó la empresa ese mes&quot;.
              </Td>
            </Tr>
            <Tr>
              <Td className="whitespace-nowrap font-medium text-[var(--color-ink)]">
                Pendiente vs. cero confirmado
              </Td>
              <Td>
                Un proyecto <em>sin costo cargado</em> no es lo mismo que uno <em>con costo cero
                real</em>. El sistema distingue ambos para que un dato faltante nunca se lea como
                ganancia.
              </Td>
            </Tr>
            <Tr>
              <Td className="whitespace-nowrap font-medium text-[var(--color-ink)]">Documento anulado</Td>
              <Td>
                Una venta se corrige anulándola, nunca borrándola: queda excluida de los reportes
                pero el historial se conserva.
              </Td>
            </Tr>
            <Tr>
              <Td className="whitespace-nowrap font-medium text-[var(--color-ink)]">
                Período de reconocimiento
              </Td>
              <Td>
                El mes al que se le atribuye una venta o costo — por defecto el mes del documento,
                reasignable a mano para trabajos que cruzan varios meses.
              </Td>
            </Tr>
            <Tr>
              <Td className="whitespace-nowrap font-medium text-[var(--color-ink)]">Asignación de costo</Td>
              <Td>
                Repartir un mismo costo entre varios proyectos, clientes o áreas, por porcentaje o
                por monto fijo.
              </Td>
            </Tr>
          </tbody>
        </TableCard>
      </Section>

      <Section id="navegacion" eyebrow="Primer contacto" title="Ingreso y navegación">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tile title="Login" route="/login">
            Correo y contraseña (Supabase Auth). No hay autorregistro: los usuarios se crean y se
            asocian a empresas desde el backend.
          </Tile>
          <Tile title="Elegir empresa" route="/companies">
            Después de iniciar sesión, ves la lista de empresas a las que tenés acceso.
          </Tile>
          <Tile title="Roles">
            Cada usuario tiene un rol por empresa. Los roles no-admin ven y cargan datos, pero no
            editan configuración inicial (empresa, áreas).
          </Tile>
          <Tile title="Selector de período">
            Arriba de cada pantalla con datos mensuales hay un selector de mes/año que reconstruye
            toda la vista para ese período.
          </Tile>
        </div>
        <p className="text-[13.5px] leading-relaxed text-[var(--color-ink-2)]">
          Una vez adentro de una empresa, el menú lateral da acceso a sus módulos: Resumen, Ventas,
          Costos, Proyectos, reportes, y en Configuración: Clientes, Proveedores, Áreas de negocio,
          Personal y Servicios recurrentes.
        </p>
      </Section>

      <Section
        id="empresas"
        eyebrow="Nivel superior"
        title="Empresas"
        lede="Cada empresa tiene su propia moneda base, datos fiscales y estado activo/inactivo."
      >
        <p className="text-[13.5px] leading-relaxed text-[var(--color-ink-2)]">
          Todo lo que se carga (ventas, costos, clientes, proyectos) pertenece a{" "}
          <strong className="text-[var(--color-ink)]">una única empresa</strong> — no hay mezcla de
          datos entre empresas, salvo en el reporte consolidado. Solo un rol{" "}
          <strong className="text-[var(--color-ink)]">admin</strong> puede crear o editar una
          empresa.
        </p>
      </Section>

      <Section
        id="configuracion"
        eyebrow="Antes de cargar el primer documento"
        title="Configuración inicial"
        lede="Estos datos base tienen que existir antes de poder cargar una venta o un costo."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tile title="Clientes" route={`/clients`}>
            Ficha única por cliente — evita duplicar nombres y permite consolidar su rentabilidad.
            Solo los activos aparecen al cargar una venta.
          </Tile>
          <Tile title="Proveedores" route={`/suppliers`}>
            Ficha única por proveedor de costos y gastos, misma lógica de activo/inactivo.
          </Tile>
          <Tile title="Áreas de negocio" route={`/areas`}>
            Clasificación del tipo de servicio (Microsoft 365, hosting, desarrollo, soporte TI,
            redes, seguridad/CCTV, GPS, energía solar, otros).
          </Tile>
          <Tile title="Personal" route={`/personnel`}>
            Personas — empleados o socios — cuyo costo mensual se puede asignar a proyectos.
          </Tile>
        </div>
      </Section>

      <Section
        id="proyectos"
        eyebrow="La unidad de rentabilidad más chica"
        title="Proyectos y su estado de costo"
        lede="Cada proyecto tiene cliente, área, estado, presupuesto y responsable, y agrupa las ventas y costos de un trabajo concreto."
      >
        <div className="flex flex-col gap-2.5">
          {[
            {
              variant: "positive" as const,
              label: "Con costos",
              text: "Ya tiene al menos un costo cargado ese mes.",
            },
            {
              variant: "neutral" as const,
              label: "Cero confirmado",
              text: "Alguien confirmó a mano que ese proyecto no tuvo costo real ese mes.",
            },
            {
              variant: "warning" as const,
              label: "Pendiente",
              text: "Todavía no se cargó costo ni se confirmó cero — el panel avisa cuántos proyectos están así, porque el resultado puede bajar cuando se complete la carga.",
            },
          ].map((row) => (
            <div
              key={row.label}
              className="flex items-start gap-3 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-3"
            >
              <Badge variant={row.variant}>{row.label}</Badge>
              <span className="pt-px text-[13px] text-[var(--color-ink-2)]">{row.text}</span>
            </div>
          ))}
        </div>
        <p className="text-[13.5px] leading-relaxed text-[var(--color-ink-2)]">
          En el reporte de rentabilidad, cada proyecto también muestra su desvío acumulado contra
          el presupuesto cargado.
        </p>
      </Section>

      <Section id="ventas" eyebrow="Carga diaria" title="Ventas">
        <div className="flex flex-col gap-2.5">
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-[var(--color-ink)]">Alta manual</h3>
              <Route>{`/sales/new`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Disponible en todas las empresas: tipo de documento (factura, recibo, nota de
              crédito, manual), cliente, proyecto y área asociados, fecha, moneda, importe
              neto/IVA/total.
            </p>
          </Card>
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-ink)]">
                Carga rápida <Badge variant="neutral">solo Uruguay</Badge>
              </h3>
              <Route>{`/sales/quick`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Formulario reducido para el uso diario en Uruguay. Necesita al menos un cliente y un
              área activos; si la empresa no es UYU, redirige directo al formulario completo.
            </p>
          </Card>
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-ink)]">
                Importación CSV/Excel <Badge variant="neutral">solo Chile</Badge>
              </h3>
              <Route>{`/sales/import`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Flujo de 3 pasos: <strong className="text-[var(--color-ink)]">1)</strong> subir
              archivo (se procesa en el navegador, no se guarda el original) →{" "}
              <strong className="text-[var(--color-ink)]">2)</strong> mapear columnas (fecha,
              cliente, importe, moneda, IVA) →{" "}
              <strong className="text-[var(--color-ink)]">3)</strong> vista previa marcando
              posibles duplicados, con carga fila por fila para que un error no bloquee el resto.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              El historial en <Route>{`/sales/import-history`}</Route> guarda cada lote con
              su archivo de origen, quién lo importó y cuántas filas se importaron, fallaron o se
              marcaron como duplicadas.
            </p>
          </Card>
          <Card>
            <h3 className="mb-1.5 text-[13.5px] font-semibold text-[var(--color-ink)]">
              Edición, anulación y filtros
            </h3>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Toda venta se puede editar, con historial de cambios. &quot;Eliminar&quot; en
              realidad <strong className="text-[var(--color-ink)]">anula</strong> el documento:
              queda registrado con fecha y usuario, pero se excluye de los reportes. El listado
              admite filtros por fecha, cliente, proyecto y área — los mismos que usa el
              drill-down desde los reportes.
            </p>
          </Card>
        </div>
      </Section>

      <Section id="costos" eyebrow="Carga diaria" title="Costos y gastos" lede={`/costs`}>
        <Bullets
          items={[
            <>
              <strong className="text-[var(--color-ink)]">Clasificación:</strong> directo
              (atribuible a un proyecto/venta puntual) o general (gasto de estructura).
            </>,
            <>
              <strong className="text-[var(--color-ink)]">Asignación de costo:</strong> un mismo
              costo puede repartirse entre varios proyectos, clientes o áreas, por porcentaje o
              monto fijo — para gastos compartidos.
            </>,
            <>
              Filtros por fecha, proyecto y clasificación, más un atajo de{" "}
              <strong className="text-[var(--color-ink)]">&quot;costos generales sin
              asignar&quot;</strong> para encontrar gastos todavía no distribuidos.
            </>,
          ]}
        />
        <div className="flex flex-col gap-2.5">
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-ink)]">
                Carga rápida desde un Trabajo <Badge variant="neutral">solo Uruguay</Badge>
              </h3>
              <Route>{`/projects/{id}/quick-expense`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Desde el detalle de un proyecto (&quot;Trabajo&quot;), el botón{" "}
              <strong className="text-[var(--color-ink)]">&quot;+ Agregar gasto&quot;</strong>{" "}
              abre un formulario mínimo pensado para cargar desde el celular: solo{" "}
              <strong className="text-[var(--color-ink)]">monto y categoría</strong> son
              obligatorios (equipos, materiales, traslados, mano de obra, otros). Descripción,
              fecha y foto del comprobante quedan opcionales. El gasto queda siempre directo,
              imputado a ese Trabajo.
            </p>
          </Card>
          <Card>
            <h3 className="mb-1.5 text-[13.5px] font-semibold text-[var(--color-ink)]">
              Provisorio, confirmado y comprobante
            </h3>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Un gasto cargado desde el celular entra como{" "}
              <Badge variant="warning">Provisorio</Badge> — una carga a ojo en el momento. Se
              vuelve <Badge variant="positive">Confirmado</Badge> al cargarse con el formulario
              completo, o cuando una factura importada lo respalda (ver más abajo). La lista de
              gastos del Trabajo avisa cuándo un provisorio todavía no tiene foto de comprobante
              adjunta.
            </p>
          </Card>
          <Card>
            <h3 className="mb-1.5 text-[13.5px] font-semibold text-[var(--color-ink)]">
              Todo a un Trabajo vs. dividir
            </h3>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Al cargar un costo se elige entre{" "}
              <strong className="text-[var(--color-ink)]">&quot;Todo a este trabajo&quot;</strong>{" "}
              (un único proyecto) o{" "}
              <strong className="text-[var(--color-ink)]">&quot;Dividir costo&quot;</strong>{" "}
              (va directo a la pantalla de asignación entre varios proyectos, clientes o áreas).
              Un costo que quedó sin asignar —por ejemplo, una factura importada— se resuelve
              después de la misma forma: &quot;Asignar a un trabajo&quot; para imputarlo entero, o
              &quot;Dividir&quot; para repartirlo.
            </p>
          </Card>
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-ink)]">
                Importación de facturas de compra <Badge variant="neutral">solo Chile</Badge>
              </h3>
              <Route>{`/costs/import`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Mismo flujo de 3 pasos que la importación de ventas: archivo → mapeo (proveedor,
              fecha, importe neto, IVA, moneda) → previsualización con detección de duplicados. Un
              proveedor que no coincide con ninguno existente se crea automáticamente. Cada
              factura importada queda como costo general sin asignar hasta que se le asigna un
              Trabajo.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              <strong className="text-[var(--color-ink)]">Vínculo sin duplicar:</strong> si ese
              gasto ya se había cargado a mano desde el celular, la previsualización deja elegir
              &quot;¿Corresponde a un gasto ya cargado?&quot; y apuntarlo al provisorio
              correspondiente — en vez de crear un documento nuevo, actualiza ese gasto con los
              datos reales de la factura, lo confirma, y conserva el Trabajo al que ya estaba
              imputado.
            </p>
          </Card>
        </div>
      </Section>

      <Section
        id="servicios-personal"
        eyebrow="Carga diaria"
        title="Servicios recurrentes y personal"
      >
        <div className="flex flex-col gap-2.5">
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-[var(--color-ink)]">
                Servicios recurrentes
              </h3>
              <Route>{`/recurring-services`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Contratos de cobro periódico (Microsoft 365, hosting, soporte, Starlink) con
              cliente, precio, costo esperado, periodicidad y vigencia. El botón{" "}
              <strong className="text-[var(--color-ink)]">&quot;Generar&quot;</strong> crea la
              venta del período automáticamente, y solo aparece si el servicio está activo,
              vigente y ese período todavía no se generó.
            </p>
          </Card>
          <Card>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-[var(--color-ink)]">
                Personal / mano de obra
              </h3>
              <Route>{`/personnel`}</Route>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              Cada persona tiene su costo mensual, cargado desde &quot;Costos&quot;. Ese costo se
              puede <strong className="text-[var(--color-ink)]">asignar a uno o más
              proyectos</strong> con un monto real y horas informativas, igual que un costo de
              proveedor. El costo de personal sin asignar entra como costo general de la empresa.
            </p>
          </Card>
        </div>
      </Section>

      <Section
        id="reportes"
        eyebrow="Adónde llega todo lo que cargaste"
        title="Los 4 reportes"
        lede="Todos usan el mismo período y las mismas reglas de cálculo — las cifras siempre reconcilian entre pantallas, y cada una tiene drill-down al documento de origen."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tile title="Panel de control" route="/companies/{id}">
            Primera pantalla al entrar a una empresa: 4 indicadores del mes vs. el anterior,
            gráfico de 12 meses, cascada de ventas → resultado, aviso de proyectos pendientes y
            ranking de proyectos.
          </Tile>
          <Tile title="Resultado mensual" route={`/reports/monthly-result`}>
            El estado de resultados clásico: ventas netas, costos directos, margen, costos
            generales (desglosados), resultado operativo.
          </Tile>
          <Tile title="Rentabilidad" route={`/reports/profitability`}>
            Tres pestañas — cliente / proyecto / área — con ingreso, costo y margen de cada uno; en
            proyectos, además el acumulado desde el inicio y el desvío vs. presupuesto.
          </Tile>
          <Tile title="Consolidado en USD" route="/reports/consolidated">
            Junta el resultado operativo de todas las empresas del usuario, convertido a dólares.
            Si el tipo de cambio no se pudo obtener, la empresa queda &quot;pendiente&quot; y se
            excluye del total.
          </Tile>
        </div>
      </Section>

      <Section
        id="reglas"
        eyebrow="Por qué se puede confiar en los números"
        title="Reglas que sostienen el sistema"
      >
        <div className="flex flex-col gap-2">
          {[
            "Un dato faltante nunca se trata como cero: proyectos sin costo y tipos de cambio no resueltos quedan explícitamente \"pendientes\".",
            "El IVA nunca es ganancia ni gasto operativo — todos los reportes trabajan sobre importes netos.",
            "Nada se borra: las correcciones quedan como anulación con trazabilidad, y las importaciones registran su archivo de origen fila por fila.",
            "Todos los reportes de una empresa usan el mismo rango de fechas y las mismas exclusiones, por lo que cualquier cifra se puede verificar yendo al detalle.",
          ].map((text) => (
            <div
              key={text}
              className="flex gap-3 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-3"
            >
              <span className="flex-none font-mono text-[13px] font-bold text-[var(--color-accent)]">
                ✓
              </span>
              <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">{text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="alcance"
        eyebrow="Para que no busques lo que no está"
        title="Qué no hace (todavía)"
        lede="El sistema calcula resultado de gestión, no reemplaza la contabilidad tributaria."
      >
        <div className="flex flex-wrap gap-2">
          {[
            "Movimientos bancarios",
            "Conciliación",
            "Flujo de caja",
            "Facturación electrónica",
            "Nómina completa",
            "CRM",
            "Mesa de ayuda / tickets",
            "Inventario avanzado",
            "Portal de clientes",
          ].map((item) => (
            <span
              key={item}
              className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-row)] px-2.5 py-1.5 text-[12px] text-[var(--color-muted)]"
            >
              {item}
            </span>
          ))}
        </div>
      </Section>

      <div className="border-t border-[var(--color-hairline)] pt-4 font-mono text-[11px] text-[var(--color-faint)]">
        Documentación técnica más detallada en docs/manual-usuario.md, en el repositorio.
      </div>
      </div>

      <GuideToc items={TOC.map((item) => ({ id: item.id, label: item.label }))} />
    </div>
  );
}
