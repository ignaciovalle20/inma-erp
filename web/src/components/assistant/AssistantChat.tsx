"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatAmount } from "@/components/Money";
import { PROJECT_STATUS_LABEL } from "@/lib/projectStatus";
// Type-only: erased at build time, nothing server-side reaches the bundle.
import type { Draft } from "@/lib/ai/tools";

type ChatMessage = { role: "user" | "assistant"; content: string };

type Turn = { message: ChatMessage; draft?: Draft };

type ConfirmState = "idle" | "pending" | "done" | "error";

// Keep in sync with MAX_HISTORY_MESSAGES in api/assistant/chat/route.ts
// -- capped here too so the request payload (and the tokens it costs)
// don't grow without bound over a long conversation.
const MAX_HISTORY_MESSAGES = 24;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_api_key: "Tu API key no es válida o no tiene permisos para ese modelo. Revisala en ajustes.",
  model_not_found: "El modelo configurado no existe o no está disponible con tu key. Elegí otro en ajustes.",
  rate_limited: "El proveedor está limitando las solicitudes en este momento. Probá de nuevo en un rato.",
  provider_error: "Hubo un error del proveedor de IA. Probá de nuevo en unos segundos.",
};

export function AssistantChat({
  companyId,
  hasAiSettings,
}: {
  companyId?: string;
  hasAiSettings: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>("idle");
  const [confirmResult, setConfirmResult] = useState<{ href: string } | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, pending]);

  const lastTurn = turns[turns.length - 1];
  const pendingDraft =
    lastTurn?.message.role === "assistant" && confirmState !== "done" ? lastTurn.draft : undefined;

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || pending) return;

    const fullHistory = [...turns.map((t) => t.message), { role: "user" as const, content: text }];
    const history = fullHistory.slice(-MAX_HISTORY_MESSAGES);
    setTurns((prev) => [...prev, { message: { role: "user", content: text } }]);
    setInput("");
    setError(null);
    setErrorDetail(null);
    setPending(true);
    setConfirmState("idle");
    setConfirmResult(null);

    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, messages: history }),
      });

      if (response.status === 409) {
        setError("not_configured");
        setTurns((prev) => prev.slice(0, -1));
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const code = typeof data.error === "string" ? data.error : "provider_error";
        setError(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.provider_error);
        if (typeof data.detail === "string") setErrorDetail(data.detail);
        return;
      }

      const data: { text: string; draft: Draft | null } = await response.json();
      setTurns((prev) => [
        ...prev,
        { message: { role: "assistant", content: data.text }, draft: data.draft ?? undefined },
      ]);
    } catch {
      setError("No pude conectarme con el asistente. Revisá tu conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  }

  async function confirmDraft() {
    if (!pendingDraft || !companyId) return;
    setConfirmState("pending");
    try {
      const response = await fetch("/api/assistant/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, draft: pendingDraft }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setConfirmState("error");
        return;
      }
      setConfirmState("done");
      setConfirmResult({ href: data.href });
      // The screen behind the chat (board, lists) shows the change right away.
      router.refresh();
    } catch {
      setConfirmState("error");
    }
  }

  function cancelDraft() {
    setConfirmState("done");
    setTurns((prev) => [
      ...prev,
      { message: { role: "assistant", content: "Listo, no guardé nada. ¿Necesitás algo más?" } },
    ]);
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {open ? (
        <div className="flex h-[32rem] w-96 max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--color-hairline)] px-4 py-3">
            <span className="text-[13.5px] font-semibold text-[var(--color-ink)]">Asistente IA</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>

          {!hasAiSettings ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-[13px] text-[var(--color-muted)]">
                Todavía no configuraste el asistente de IA.
              </p>
              <Link
                href="/settings/ai"
                className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-on-ink)] no-underline hover:bg-[var(--color-primary-hover)]"
              >
                Configurar ahora
              </Link>
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
                {turns.length === 0 ? (
                  <p className="text-[12.5px] text-[var(--color-muted)]">
                    Preguntame sobre tus ventas, gastos o resultados. También puedo ayudarte a
                    cargar un gasto o una venta.
                  </p>
                ) : null}
                {turns.map((turn, index) => (
                  <div key={index} className="flex flex-col gap-2">
                    <div
                      className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] ${
                        turn.message.role === "user"
                          ? "self-end bg-[var(--color-ink)] text-[var(--color-on-ink)]"
                          : "self-start bg-[var(--color-row)] text-[var(--color-ink)]"
                      }`}
                    >
                      {turn.message.content}
                    </div>
                    {turn.draft && turns[turns.length - 1] === turn ? (
                      <DraftCard
                        draft={turn.draft}
                        state={confirmState}
                        result={confirmResult}
                        onConfirm={confirmDraft}
                        onCancel={cancelDraft}
                      />
                    ) : null}
                  </div>
                ))}
                {pending ? (
                  <div className="self-start rounded-lg bg-[var(--color-row)] px-3 py-2 text-[13px] text-[var(--color-muted)]">
                    Pensando…
                  </div>
                ) : null}
                {error === "not_configured" ? (
                  <p className="text-[12.5px] text-[var(--color-negative-ink)]">
                    Tu configuración de IA ya no es válida.{" "}
                    <Link href="/settings/ai" className="underline">
                      Revisala en ajustes
                    </Link>
                    .
                  </p>
                ) : error ? (
                  <div className="text-[12.5px] text-[var(--color-negative-ink)]">
                    <p>{error}</p>
                    {errorDetail ? (
                      <p className="mt-0.5 font-mono text-[10.5px] text-[var(--color-muted)]">
                        {errorDetail}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <form onSubmit={sendMessage} className="flex items-center gap-2 border-t border-[var(--color-hairline)] px-3 py-3">
                <input
                  type="text"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Escribí tu pregunta…"
                  disabled={pending}
                  className="flex-1 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-ink)] disabled:bg-[var(--color-canvas)]"
                />
                <button
                  type="submit"
                  disabled={pending || !input.trim()}
                  className="rounded-lg bg-[var(--color-ink)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-on-ink)] disabled:opacity-50"
                >
                  Enviar
                </button>
              </form>
            </>
          )}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={open ? "Cerrar asistente" : "Abrir asistente"}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-[22px] text-[var(--color-on-accent)] shadow-lg hover:bg-[var(--color-accent-strong)]"
      >
        {open ? "✕" : "💬"}
      </button>
    </div>
  );
}

function DraftCard({
  draft,
  state,
  result,
  onConfirm,
  onCancel,
}: {
  draft: Draft;
  state: ConfirmState;
  result: { href: string } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const title = DRAFT_TITLE[draft.kind];

  return (
    <div className="self-start w-full max-w-[85%] rounded-lg border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] p-3 text-[12.5px]">
      <p className="font-semibold text-[var(--color-ink)]">{title}</p>
      <dl className="mt-1.5 flex flex-col gap-0.5 text-[var(--color-ink-2)]">
        <DraftRows draft={draft} />
      </dl>

      {draft.kind === "expense" && draft.duplicateWarning ? (
        <p className="mt-2 rounded-md border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-2 py-1.5 text-[var(--color-warning-ink)]">
          Posible duplicado: ya existe un gasto del {draft.duplicateWarning.document_date} por{" "}
          {formatAmount(draft.duplicateWarning.total_amount, draft.duplicateWarning.currency)}{" "}
          {draft.duplicateWarning.currency} con el
          mismo proveedor y total.
        </p>
      ) : null}

      {state === "done" && result ? (
        <p className="mt-2 text-[var(--color-accent-strong)]">
          Guardado.{" "}
          <Link href={result.href} className="underline">
            Ver
          </Link>
          .
        </p>
      ) : state === "done" ? (
        <p className="mt-2 text-[var(--color-muted)]">Descartado.</p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={state === "pending"}
            className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-on-ink)] disabled:opacity-60"
          >
            {state === "pending" ? "Guardando…" : "Confirmar"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={state === "pending"}
            className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] text-[var(--color-ink)] disabled:opacity-60"
          >
            Cancelar
          </button>
          {state === "error" ? (
            <span className="self-center text-[var(--color-negative-ink)]">Error al guardar.</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

const DRAFT_TITLE: Record<Draft["kind"], string> = {
  expense: "Nuevo gasto",
  sale: "Nueva venta",
  project: "Nuevo trabajo",
  project_status: "Cambio de estado",
};

const SALE_TYPE_LABEL: Record<string, string> = {
  invoice: "Factura",
  receipt: "Boleta",
  credit_note: "Nota de crédito",
  manual: "Venta sin factura",
};

function DraftRows({ draft }: { draft: Draft }) {
  if (draft.kind === "project") {
    return (
      <>
        <Row label="Trabajo" value={draft.name} />
        <Row label="Cliente" value={draft.client_name} />
        <Row label="Área" value={draft.business_area_name} />
        <Row label="Cotización" value={draft.quote_number ?? "—"} />
        <Row label="Estado" value={PROJECT_STATUS_LABEL[draft.status]} />
        {draft.quoted_amount !== null ? <Row label="Monto cotizado" value={`${formatAmount(draft.quoted_amount, draft.currency)} ${draft.currency}`} /> : null}
        {draft.cost_budget !== null ? <Row label="Presupuesto de costo" value={`${formatAmount(draft.cost_budget, draft.currency)} ${draft.currency}`} /> : null}
        {draft.responsible ? <Row label="Responsable" value={draft.responsible} /> : null}
        {!draft.invoiceable ? <Row label="Facturable" value="No" /> : null}
      </>
    );
  }

  if (draft.kind === "project_status") {
    return (
      <>
        <Row label="Trabajo" value={draft.project_name} />
        <Row
          label="Estado"
          value={`${PROJECT_STATUS_LABEL[draft.from_status]} → ${PROJECT_STATUS_LABEL[draft.status]}`}
        />
        {draft.hold_reason ? <Row label="Motivo" value={draft.hold_reason} /> : null}
      </>
    );
  }

  return (
    <>
      <Row
        label={draft.kind === "expense" ? "Proveedor" : "Cliente"}
        value={draft.kind === "expense" ? (draft.supplier_name ?? "Sin proveedor") : draft.client_name}
      />
      {draft.kind === "sale" ? <Row label="Tipo" value={SALE_TYPE_LABEL[draft.document_type] ?? draft.document_type} /> : null}
      {draft.kind === "expense" ? (
        <Row label="Clasificación" value={draft.classification === "direct" ? "Directo" : "General (a dividir)"} />
      ) : null}
      {draft.project_name ? <Row label="Trabajo" value={draft.project_name} /> : null}
      <Row label="Fecha" value={draft.document_date} />
      <Row
        label="Total"
        value={`${formatAmount(draft.total_amount, draft.currency)} ${draft.currency} (neto ${formatAmount(draft.net_amount, draft.currency)} + IVA ${formatAmount(draft.tax_amount, draft.currency)})`}
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
