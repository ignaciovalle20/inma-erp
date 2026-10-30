# Limpieza de costos, 2026-10-30

Diagnóstico y limpieza de los puntos 9 y 11. Los archivos `resultado_*` son la salida guardada.

## Punto 9: duplicados y huérfanos

| Archivo | Qué hace | Dev | Prod |
|---|---|---|---|
| `01_diagnostico.sql` | Solo SELECT | ejecutado | ejecutado |
| `02_limpieza.sql` | Corrige en una transacción, idempotente | **aplicado** | **sin ejecutar** |

Resultado en prod (`resultado_diagnostico_prod.json`, dev da lo mismo salvo H2):

| Chequeo | Prod | Qué significa |
|---|---|---|
| D1 documentos de costo duplicados (RUT + tipo + folio) | 0 | Los índices únicos de `20261030020000` ya lo cubren. |
| D2 documentos de venta duplicados | 0 | |
| D3 proveedores con el mismo RUT | 0 | |
| H1 filas `imported` sin documento ni marca | 0 | |
| H2 filas con marca de borrado | 2 | FAC-EL 257 y FAC-EL 3706346. Es lo que hacía saltar "duplicado". Ya no bloquean: quedan como historial. |
| H5 documentos `source=import` sin fila | 3 | Tres de $1.000 sin folio (2026-02, 06, 07). No se tocan: revisar si son de prueba. |
| H8 sugerencias vencidas | 0 | |
| H9 / H10 Storage sin fila / fila sin archivo | 0 | |
| H12 `import_rows` de ventas sin documento | 9 | Lote `5072cfa8` del script de Uruguay. Conocido, no se toca. |
| A1 documentos anulados en su archivo | 1 | BOL-HE 156, ver abajo. |

### Qué haría `02_limpieza.sql` en prod

Solo un cambio: borra **BOL-HE 156** de LUIS ESTEBAN FUENTES CATRIN (`80d47e72-7165-4cfa-82c9-2f32567f178a`, 2026-07-06, neto y total 500.000, Estado `Anulada`), con su línea. Sin asignación, sin vínculos ni adjuntos. Su fila de importación queda como historial. **El costo general de julio 2026 de Chile baja 500.000.**

L2 y L3 no encuentran nada hoy. El script deja intacto y lista como "REVISAR A MANO" cualquier documento anulado que ya esté en uso.

### Cómo correrlo

Después de hacer backup y con las migraciones de prod aplicadas:

```bash
npx supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f ../audit/2026-10-30-limpieza-costos/02_limpieza.sql -o json
```
