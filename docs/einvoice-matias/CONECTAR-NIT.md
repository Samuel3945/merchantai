# Cómo conectar un cliente (NIT) nuevo a la facturación electrónica

Guía corta para habilitar la facturación electrónica (MATIAS) a un negocio nuevo.
Hay dos roles: **vos como plataforma** (una sola vez por la cuenta MATIAS y por
plan) y el **dueño del negocio** (los datos de su NIT).

## 1. Una sola vez — configuración de la plataforma

La cuenta MATIAS es **una sola para todo MerchantAI** ("Casa de Software"). Se
configura por variables de entorno en el VPS (Easypanel), NO por tenant:

```
MATIAS_API_BASE_URL=https://sandbox-api.matias-api.com/api/ubl2.1
MATIAS_ACCOUNT_EMAIL=<email de la cuenta MATIAS>
MATIAS_ACCOUNT_PASSWORD=<contraseña de la cuenta MATIAS>
```

> La URL apunta SIEMPRE al **sandbox**. Producción se configura aparte y a
> conciencia (ver "Pasar a producción").

## 2. Una vez por plan — créditos de facturación

Cada documento emitido **consume 1 crédito** del tenant (igual que la IA). En el
panel de plataforma → **Planes (PlansStudio)**, agregá a cada plan el entitlement:

- Clave: `ai_credits_einvoice`
- Valor: cantidad de documentos/mes que incluye el plan (ej. `500`)

Sin este valor (o en `0`), el negocio no puede emitir y verá: *"No te quedan
créditos de facturación."*

## 3. Por cada negocio — el dueño carga sus datos

El dueño (admin de la organización) entra a **Ajustes → Facturación** y:

1. Elige el proveedor **MATIAS (DIAN)**.
2. Completa:
   - **NIT del emisor** (su NIT).
   - **Resolución DIAN (descripción)**.
   - **Número de resolución** (el número exacto que le dio la DIAN).
   - **Prefijo** (ej. `FEV`).
   - **Estado del certificado**: en sandbox, MATIAS genera uno de prueba
     automáticamente → ponelo en **Activo** para poder emitir.
3. (Opcional) Activa **Facturación automática**: cada venta emite su documento
   sola. Si lo deja apagado, emite manualmente desde el módulo **Facturas**.
4. Toca **Probar conexión** para confirmar que la cuenta MATIAS responde.

Listo: las ventas a consumidor final emiten **POS electrónico** y las ventas con
cliente identificado emiten **factura electrónica**.

## 4. Pasar a producción (real ante la DIAN)

El sandbox es gratis y no afecta a la DIAN. Para emitir de verdad:

- Contratar el servicio con MATIAS (la cuenta "Casa de Software" en producción).
- Cambiar `MATIAS_API_BASE_URL` a la URL de producción que entrega MATIAS, y las
  credenciales de la cuenta de producción.
- Cada NIT necesita su **certificado de firma real** (`.p12`) cargado/activado en
  MATIAS y su **resolución de numeración** vigente.
- Recién ahí los documentos quedan reportados ante la DIAN.
