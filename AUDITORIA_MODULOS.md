# Auditoría de módulos — MyMerchant AI vs Tiendademo vs Diseño "Tienda Control"

_Generado: 2026-05-30 · Base: código real del repo `merchantai`, app Tiendademo (referencia de UX/lógica) y el handoff de diseño `Tienda Control` (Claude Design)._

## Resumen ejecutivo

MyMerchant AI **no es un esqueleto**: tiene 26 tablas, módulos con miles de
líneas (settings 1929, employees 1003, inventory 874, fiados 447) y un módulo de
**Reportes más completo que el propio diseño** (8 sub-vistas). El trabajo no es
"construir desde cero", es **alinear UX al diseño Tienda Control** y **cerrar los
módulos activables que faltan** (el verdadero diferenciador de la visión:
software modular + agente IA por WhatsApp/Telegram vía n8n).

### Modelo de datos actual (26 tablas)
`products · sales · sale_items · sale_payments · cash_sessions · cash_movements ·
pos_users · pos_sessions · pos_tokens · employee_invitations · organization_plans ·
plan_addons · subscriptions · usage_counters · top_ups · customers · pos_returns ·
pos_return_items · stock_movements · expiration_risk_cache · expiration_suggestions ·
payment_methods · notifications · audit_logs · app_settings · todo`

**Ausencias notables en el modelo** (gaps del diseño): no hay tabla de
`suppliers`, `delivery/domicilios`, `loyalty`, ni un registro explícito de
`modules` (la activación modular parece vivir dentro de `app_settings`).

---

## Tabla comparativa módulo por módulo

| Módulo | MyMerchant (estado real) | Tiendademo (referencia) | Diseño Tienda Control | Gap / Acción |
|---|---|---|---|---|
| **POS cajero** | `pos-cajeros` + `pos_tokens` (390 LOC) + tablas `sales` | `POS.tsx`, `PosCajeros.tsx` | Artboard "POS tablet" (grid productos, carrito 420px, total grande, pago+fiado) | Lógica lista; **alinear UX** al layout del diseño (carrito ancho fijo, foco en código de barras, total XL) |
| **Caja (apertura/cierre)** | `cash_sessions`, `cash_movements`, reporte `analisis-caja` (131 LOC) | `Cash.tsx` | Artboard "Cierre de caja" | Tablas y reporte listos; **falta pantalla de cierre de caja dedicada** (resumen + arqueo) como en el diseño |
| **Ventas / Historial** | `sales/*` (290 LOC) + `sale_items`/`sale_payments` | `SalesHistory.tsx` | Detalle "Venta + recibo" | OK. Comparar el detalle de recibo |
| **Inventario** | `inventory` (874 LOC), `stock_movements`, `expiration_risk_cache`, `expiration_suggestions` | `Inventory.tsx`, `Thresholds.tsx` | Artboard "Inventario" (lotes, vencimientos, márgenes, filtros) | **Fuerte** — vencimientos ya modelados. Pulir tabla/márgenes al diseño |
| **Productos** | `products` (413 LOC) | `Products.tsx` | Detalle "Producto con lotes" | OK |
| **Fiados** | `fiados` (447 LOC) | `Fiados.tsx` | "Muro de Fiados" (riesgo urgente/recordar/al-día, **recordar por WhatsApp**, historial) | Sin tabla dedicada (vía `customers`/crédito). **Faltan:** scoring de riesgo + botón "recordar por WhatsApp" |
| **Clientes** | `customers` (422 LOC) + tabla | `Customers.tsx` | "Cliente con historial" | OK |
| **Empleados / Cajeros** | `employees` (1003 LOC), `pos_users`, `employee_invitations`, PIN | `Employees.tsx`, `CashierManagement.tsx` | "Empleados" + permisos de cajero | **Muy maduro** (PIN + invitaciones). Mapear permisos por rol del diseño |
| **Reportes** | 8 sub-vistas (analisis-caja, inventario, fiados, perdidas, ventas-periodo/metodo/cajero, top-productos) | `Reports.tsx` | Artboard "Reportes" | **Merchant supera al diseño.** Solo dar consistencia visual |
| **Agente IA** | `ai-agent` (385 LOC) | `AIAgent.tsx` | "Asistente IA" — **el diferenciador**: WhatsApp/Telegram vía n8n, panel de aprobación, seguridad por capas, PIN para cambios críticos | Base existe. **Faltan:** conexión real n8n, cola de acciones con aprobación, modelo de seguridad por riesgo (bajo=directo, medio=in-chat, alto=PIN en app) |
| **Módulos activables** | `settings` (1929 LOC) + `app_settings` | `ModulesPage.tsx` | "Módulos" — **el corazón** de la visión | Verificar si hay registro/activación de módulos real. Si no, **crear catálogo de módulos** on/off |
| **Onboarding** | `onboarding` (398 LOC) | `Onboarding.tsx` | "Onboarding 5 pasos + vincular WhatsApp/Telegram" | Existe; **falta el paso de vincular el agente** (WhatsApp + n8n) |
| **Planes / Billing** | `plans` (370 LOC), `billing`, `subscriptions`, `top_ups`, `usage_counters` | `Plans.tsx` | (no en diseño) | OK |
| **Notificaciones** | tabla `notifications` | `NotificationBell` | Artboard "Notificaciones" | Tabla lista; revisar UI |
| **Proveedores** | ❌ no existe | `Suppliers.tsx` | Artboard "Proveedores" | **FALTA** en Merchant |
| **Domicilios / Delivery** | ❌ no existe | `Delivery.tsx` | "Configurar Domicilios" + web marketplace pública | **FALTA** (módulo activable estrella) |
| **Facturación electrónica DIAN** | ❌ no existe | `Invoices.tsx` | "Facturación DIAN" | **FALTA** |
| **Promos / Lealtad / Suscripciones / Recetas / Contabilidad / Marketing WhatsApp / Multi-sucursal** | ❌ no existen | parcial | módulos activables listados en el diseño | **FALTAN** (roadmap modular) |

---

## Gaps priorizados (sugerencia de orden)

1. **Consistencia visual** — aplicar el design system Tienda Control (✅ ya
   instalado en `global.css`: teal `#0F766E`, Fraunces/Inter Tight) a todas las
   pantallas del dashboard, no solo la landing.
2. **Cierre de caja** dedicado (pantalla de arqueo) — tablas ya existen.
3. **Fiados al estilo "muro"** — scoring de riesgo + "recordar por WhatsApp".
4. **Agente IA real** — el diferenciador: cola de acciones + aprobación con PIN +
   seguridad por capas + conexión n8n. Aquí está el valor del producto.
5. **Catálogo de módulos activables** — registro on/off (Domicilios, Proveedores,
   DIAN, Lealtad, Promos...). Convertir la visión modular en realidad.
6. **Módulos faltantes** uno por uno: Proveedores → Domicilios → DIAN → resto.

## Notas de método
- "Estado real" se midió por LOC de cada `src/features/<modulo>/`, páginas del
  dashboard y tablas en `src/models/Schema.ts`.
- Tiendademo se usa como **referencia de lógica/UX** (Vite+React), no de código a
  copiar literal.
- El diseño Tienda Control aporta la **capa visual y la visión de producto**
  (21 artboards, modular + agente IA). Bundle en `_design_tiendacontrol/`.
