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

## Puntos 10 y 11: RUT y boletas

| Archivo | Qué hace | Dev | Prod |
|---|---|---|---|
| `03_diagnostico_rut_boletas.sql` | Solo SELECT, antes de las migraciones | ejecutado | ejecutado |
| `04_verificacion_boletas.sql` | Solo SELECT, después de `20261031030000` | ejecutado | correrlo al desplegar |

Lo corrigen las migraciones `20261031020000` y `20261031030000`, no un script aparte.

Lo que encontró `03` en prod (`resultado_rut_boletas_prod.json`):

| Chequeo | Prod | Qué hará la migración |
|---|---|---|
| R1 RUT de técnicos con otro formato | 1 | Luis Fuentes: `137658720` pasa a `13765872-0`. |
| R2 RUT de proveedores con otro formato | 0 | |
| R4 técnico y proveedor con el mismo RUT, sin vincular | 2 | Vincula a EXEQUIAS CATRIN y a CARLOS GUTIERREZ con su proveedor (2 documentos cada uno). |
| R5 un RUT en dos fichas | 0 | |
| B1 neto guardado distinto del `Neto` del archivo | 0 | **Ninguna boleta tiene el líquido guardado como bruto.** |
| B3 retención que no es la tasa de su año | 7 | 5 boletas de 2024 al 13,75 %, sin fila en la tabla: se agrega 2020-2024. 2 de 2025 sin retención (`Total = Neto`, folios 97588 y 131836): se respeta el archivo. |
| B4 boletas en total | 20 | Reciben `withholding_amount` y `liquid_amount`. Sin cambios en `net_amount` ni `total_amount`, así que ningún costo se mueve. |

### El ejemplo de la BOL-HE 156

El archivo de Nubox dice: `Neto 500.000`, `Total 423.750`, `Estado Anulada`. El bruto guardado es correcto. Lo que pasa es que esa boleta está anulada y no es la del cargo:

| Boleta | Estado | Bruto | Líquido |
|---|---|---|---|
| BOL-HE 156 | **Anulada** | 500.000 | 423.750 |
| BOL-HE 157 (misma fecha) | Válido | 589.970 | 500.000 |
| BOL-HE 158 | Válido | 589.970 | 500.000 |

El cargo de Luis Fuentes del 2026-07-06 (costo 589.970, a pagar 500.000) cuadra con la 157. Los 500.000 de "a pagar" y de "bruto" coinciden por casualidad: por eso la diferencia parecía la retención.

## Cómo correrlo en prod

Después de hacer backup y con las migraciones de prod aplicadas:

```bash
npx supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f ../audit/2026-10-30-limpieza-costos/02_limpieza.sql -o json
```

```bash
npx supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f ../audit/2026-10-30-limpieza-costos/04_verificacion_boletas.sql -o json
```
