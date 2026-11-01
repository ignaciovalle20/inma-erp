# Facturas de técnicos como gasto de proveedor y repartos sobre el total (2026-11-01)

| Archivo | Qué es | Dónde se corrió |
|---|---|---|
| `01_diagnostico.sql` | Solo SELECT: facturas de técnicos como gasto de proveedor, costos contados dos veces, repartos con el total | prod y dev |
| `02_correccion_fac257.sql` | Vincula la FAC-EL 257 a sus 4 cargos. Idempotente, en transacción, todo o nada | **solo dev** |
| `03_efecto_correccion.sql` | Solo SELECT: cuánto lleva cada trabajo por la FAC-EL 257, antes y después | dev |
| `dev_preparar_fac257.sql` | Solo dev: deja la FAC-EL 257 y sus cargos como para probar la corrección | dev |
| `resultado_*.json` | Lo que devolvió cada uno | |

## Diagnóstico en prod (2026-11-01)

Los repartos con el total los convierte la migración `20261101010000`, no este script. Ningún reporte se mueve más que el redondeo, porque ya convertían a neto.

| Documento | Antes (con IVA) | Después (neto) |
|---|---|---|
| Intcomex FAC-EL 3706346 | 404.031 + 1.421.834 | 339.522 + 1.194.818 |
| Intcomex FAC-EL 3710228 | 92.440 + 1.024.509 | 77.681 + 860.932 |
| Luis Fuentes FAC-EL 257 | 2.000.000 + 400.000 + 45.000 + 109.993 | 1.680.672 + 336.134 + 37.815 + 92.432 |

### FAC-EL 257

Está como costo general repartida entre 4 trabajos, con el total. Redes se cuenta dos veces: su cargo de 1.680.672 y su parte del reparto.

| Trabajo | Neto esperado | Qué hay en prod |
|---|---|---|
| Redes en colegios del interior | 1.680.672 | **Existe:** factura, neto 1.680.672, a pagar 2.000.000, sin pagar |
| STARLINK La Ligua | 336.134 | **No coincide:** Luis Fuentes tiene 210.000 sin respaldo (pagado). "Luis con F" tiene 802.521 neto (pagado) |
| Control de acceso HIK | 92.432 | **No coincide:** Luis Fuentes tiene 195.000 sin respaldo (pagado). "Luis con F" tiene 132.773 neto (pagado) |
| Tintas Wind | 37.815 | **No existe ningún cargo** en ese trabajo |

Por eso, hoy `02_correccion_fac257.sql` en prod no cambiaría nada: listaría los 3 cargos que faltan y terminaría en `SIN CAMBIOS`. No se inventaron cargos.

### Para revisar a mano

- **"Luis con F":** es otra ficha de técnico, sin RUT vinculado, con 3 cargos de factura ya pagados (Starlink 955.000, HIK 158.000, Bodega 12 75.000). Sus cargos no aparecen en las facturas de LUIS FUENTES CATRIN E.I.R.L., que es de la ficha "Luis Fuentes". Parece la misma persona: si es así, hay que decidir si se unifican. Esto no se tocó.
- **FAC-EL 264 (neto 4.923.000):** está asignada directa a Redes, que además tiene un cargo de 4.201.684 con la FAC-EL 262. Puede ser un costo doble. No se tocó.
- **18 documentos más de técnicos** están sin vincular, como costo general (chequeo T2). Se vinculan desde cada documento.

## Cómo dejar la FAC-EL 257 en prod

Después del deploy, por una de estas dos vías:

1. **Desde la pantalla (recomendado):** abrir la FAC-EL 257, "Es de un técnico". Elegir Redes, crear ahí los cargos que faltan, confirmar "Reemplazar la asignación actual" y "Vincular factura".
2. **Con el script:** cargar los 3 cargos y correr `02_correccion_fac257.sql`. Reconoce un cargo si su neto da el esperado (±1 peso). Sin respaldo, su monto se lee como total con IVA.

```bash
npx supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f ../audit/2026-11-01-facturas-tecnicos/02_correccion_fac257.sql -o json
```

Después de vincular:
- El documento sigue como general, sin reparto, y `technician_linked_amount` = 2.147.053 (o 2.147.052 si un cargo se redondeó).
- Cada trabajo lleva el costo de su cargo, en el mes del cargo.
- Redes deja de contarse dos veces: baja 1.680.672.
- Los montos de Starlink, HIK y Tintas dejan de venir del reparto y pasan a venir de sus cargos.

## Resultado en dev

La corrección vinculó los 4 cargos (aplicado 2.147.053, diferencia 0). La segunda corrida no hizo nada. Los datos de los 4 cargos en dev son de prueba.
