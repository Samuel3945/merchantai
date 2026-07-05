# Efectivo Caja ↔ Domiciliario ↔ Caja (préstamos y saldo del domiciliario)

> Estado: **borrador acordado** con el dueño. Fase 1 = relación caja ↔ domiciliario.
> La relación caja ↔ caja reutiliza exactamente el mismo mecanismo.

Dibujito de referencia: artefacto "Flujo de efectivo · Caja ↔ Domiciliario".

## 1. Problema

En una tienda el efectivo lo tocan varias manos: cajeros y domiciliarios. Hoy la
venta a domicilio en efectivo cae directo al cajón de la caja declarada, pero
físicamente esa plata está en el bolsillo del domiciliario (de ahí saca vuelto).
Eso descuadra la caja y no deja saber **cuánta plata hay "en la calle"** ni a quién
atribuir una fuga.

## 2. Modelo conceptual: dos bolsillos

El efectivo siempre está en **un solo contenedor a la vez**. Nunca en dos, nunca en
ninguno. Esa es la regla que hace que todo cuadre y sea auditable.

- **Cajón (caja)** — el efectivo físico del registro. Es la `cash_session` de un
  `pos_token`. Se abre, se arquea y se cierra.
- **Domiciliario** — una "tesorería" con **saldo propio**, atada a su turno
  (`courier_shifts`). Es un contenedor de efectivo más, como `caja_fuerte` o
  `transito`, pero por persona.

Un **domiciliario** es un `pos_user` (empleado) con el módulo `delivery` habilitado
y `active = true`.

## 3. Los 3 movimientos de plata

| # | Movimiento | Cajón | Bolsillo domiciliario | Cómo se registra |
|---|---|---|---|---|
| 1 | **Base para vueltos** (caja → domi) | −$ | +$ | Manual, en la vista Caja del POS |
| 2 | **Venta a domicilio en efectivo** (cliente → domi) | *no toca* | +$ total | **Automático** al marcar "entregado" con pago efectivo |
| 3 | **Entrega a caja** (domi → caja) | +$ | −$ | Manual, desde la UI del domiciliario |

**Saldo esperado del domiciliario en cualquier momento:**

```
saldo = base recibida + ventas efectivo cobradas − entregado a caja
```

Nunca se guarda un saldo "absoluto": **se deriva del ledger** (misma filosofía que
la regla de stock FIFO de este repo — nunca fijar un valor absoluto que se pueda
desincronizar).

## 4. Registro: una sola firma, sin confirmación

El movimiento lo declara **una sola persona** y queda como verdad. **No** se pide
confirmación de la contraparte.

Razón: en una **caja compartida** el efectivo lo tocan varias manos, así que un
esquema de "yo digo que sí metí / el otro dice que no" es **imposible de resolver**
(no hay fuente de verdad). Confirmar solo agregaría fricción sin resolver nada. Es
una limitación aceptada a cambio de la comodidad de compartir.

- La **venta** (movimiento 2) se auto-registra: el domiciliario no digita nada.
- La **base** y la **entrega a caja** las registra manualmente quien las hace.
- Si el celular del domiciliario está sin señal/batería al final, el **cajero puede
  registrar la entrega final por él** (misma firma única, queda a nombre de quien
  registró).

## 5. Offline y cierre de caja

- **Vender a domicilio funciona offline**: se encola y sube después (idempotente por
  UUID generado en el dispositivo, igual que `sale_idempotency_key`).
- **Cerrar la caja también funciona offline.** El cajero puede cerrar aunque falten
  movimientos del domiciliario por sincronizar; en ese caso el cierre queda con un
  **excedente** (el cajón tiene más efectivo del que el sistema conoce, porque una
  entrega del domiciliario aún no ha llegado).
- **Reconciliación posterior:** cuando suben los abonos/movimientos de las ventas a
  domicilio y las entregas, el `expected` de esa sesión (aunque ya esté cerrada) se
  **recalcula** y la `difference` converge a exacto. Un movimiento que llega tarde
  se adjunta a su sesión correcta y ajusta el arqueo retroactivamente.
- Regla de oro: el `expected` y el saldo del domiciliario **siempre se derivan del
  ledger**, así que "llegar tarde" nunca corrompe nada, solo actualiza el número.

## 6. Detección de fuga

Al cerrar turno, el domiciliario cuenta lo que lleva encima. Si es **menos** que el
saldo esperado, el faltante queda marcado **a su nombre** — no como un descuadre
anónimo del cajón. Eso es lo que hace que "funcione bien si hay fuga".

Comportamiento al faltante: **no se bloquea la operación**. Cierra el turno, queda
registrado en rojo para auditoría y se notifica. (No frenar la caja por un
faltante.)

## 7. Caja compartida vs. dividida (es responsabilidad, no plata)

- **Dividida** — la plata de esa caja la maneja **un solo responsable**. Si
  descuadra, hay **un culpable claro**.
- **Compartida** — la misma plata la comparten varios (cajeros entre sí y con
  domiciliarios). Si descuadra, es **responsabilidad colectiva, sin culpable único**.

Efecto funcional del modo:
- **Compartida**: la caja se puede compartir **con otras cajas (POS) y con
  domiciliarios**. La UI muestra **con cuáles POS** comparte.
- **Dividida**: la caja es independiente.

### Reglas de cascada (UI admin)

1. Al **crear un perfil de domiciliario** y marcar que **va a compartir caja**, las
   cajas involucradas pasan a estado **compartida (con el domiciliario)**.
2. Si el **domiciliario cambia a dividida**, **todas las demás cajas cambian a
   dividida** también (se rompe el pozo compartido para todos).

> Nota: el saldo del domiciliario es siempre "suyo" (siempre hay un responsable
> claro de su bolsillo). El modo compartida/dividida describe cómo se comparte el
> **cajón** entre cajeros/cajas.

## 8. Cambios por superficie

### 8.1 Base de datos (repo `merchantai`)
- `pos_tokens.cash_mode` — enum `pos_cash_mode` (`shared` | `divided`), default
  `divided`. Marca si el cajón es compartido o independiente.
- **Ledger del bolsillo del domiciliario** — tabla nueva `courier_cash_movements`
  (append-only):
  - `id uuid` (generado en el dispositivo → idempotente offline)
  - `organization_id`, `shift_id` (→ `courier_shifts`), `courier_id` (→ `pos_users`)
  - `pos_token_id` (la caja contraparte, cuando aplica)
  - `direction` — `base_from_caja` | `handover_to_caja` | `sale_collected`
  - `amount numeric(12,2)`
  - `sale_id` (solo para `sale_collected`)
  - `created_by` (pos_user que lo registró), `created_at`
  - `client_movement_id uuid` (idempotencia offline; UNIQUE por org)
- El saldo del domiciliario se **deriva** de esta tabla. No hay columna de saldo.

### 8.2 Panel admin — Caja POS (`dashboard/pos-cajeros`)
- Control visual bonito por caja: **Compartida / Dividida**.
- Si es compartida: mostrar **con cuáles POS** comparte (chips).
- Aplicar las reglas de cascada de §7 en la action.

### 8.3 Tesorería (`dashboard/tesoreria`)
- **Bolsillo de domiciliarios**: pocket derivado que muestra **cuánta plata lleva
  encima cada domiciliario** (dinero "en la calle"), para que el dueño lo sepa.
- **Solo aparece si hay empleados con perfil de domiciliario activos.**
- No es una `treasury_accounts` real: se calcula del ledger §8.1.

### 8.4 POS — vista Caja (`pos-merchatai` · `CajaCajero.tsx`)
- Nuevo **motivo de salida "Préstamo"** con selector **"¿a quién?"**: otra caja
  (POS) / un domiciliario. Registra el movimiento §3.1 / caja↔caja.
- (`src/lib/cash-motivos.ts` + el modal de movimientos.)

### 8.5 POS — UI del domiciliario (`pos-merchatai`)
- Mostrar **cuánto lleva encima** (saldo derivado).
- Botón **"Entregar dinero a caja"** (movimiento §3.3), offline-capable.

## 9. Fases de entrega

1. **Fase 1 — Backend + admin (repo `merchantai`)**: migración `cash_mode` +
   `courier_cash_movements`, lib del ledger/saldo, endpoints POS, UI admin
   compartida/dividida, pocket de domiciliarios en tesorería, auto-registro de la
   venta a domicilio al bolsillo + recálculo de arqueo.
2. **Fase 2 — POS (repo `pos-merchatai`)**: motivo "Préstamo" + "¿a quién?" en la
   vista Caja, y UI del domiciliario (saldo + entregar a caja), todo offline.
3. **Fase 3 — Caja ↔ caja**: reutiliza el mismo ledger y UI (mismo mecanismo de
   préstamo, contraparte = otra caja).

## Decisiones cerradas (resumen)
- Domiciliario = bolsillo con saldo propio, derivado del ledger.
- Venta a domicilio en efectivo → bolsillo del domiciliario, NO al cajón.
- Un solo registro, sin confirmación de la contraparte.
- Cerrar caja funciona offline con excedente; reconcilia a exacto al sincronizar.
- Fuga = saldo esperado vs contado, a nombre del domiciliario; no bloquea.
- Compartida/dividida = modelo de responsabilidad, con reglas de cascada.
- Tesorería muestra el dinero "en la calle" por domiciliario (solo si hay activos).
