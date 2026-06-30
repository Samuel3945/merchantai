# Aceptación de Términos en el registro

Objetivo: que **al registrarse**, todo usuario acepte los Términos y la Política
de Privacidad. No se hace en el onboarding, sino en el formulario de registro
(Clerk `<SignUp>`).

## Lo que ya quedó en el código

- **Páginas públicas** (accesibles sin login):
  - `/legal/terminos` → `src/app/[locale]/legal/terminos/page.tsx`
  - `/legal/privacidad` → `src/app/[locale]/legal/privacidad/page.tsx`
- **Aviso con enlaces** debajo del formulario de registro
  (`.../sign-up/[[...sign-up]]/page.tsx`): "Al registrarte aceptas nuestros
  Términos… y Política de Privacidad…".

## El paso que falta (1 sola vez, en el panel de Clerk)

El formulario de registro lo dibuja Clerk. Para que muestre un **checkbox
obligatorio** de aceptación (no solo el aviso de texto), hay que activar el
consentimiento legal en el dashboard de Clerk:

1. Entra a **dashboard.clerk.com** → tu aplicación (la de producción).
2. Ve a **Configure → User & Authentication → Legal consent**
   (en algunas versiones: **Configure → Legal**).
3. Activa **"Require express consent to legal documents"**.
4. En **Terms of Service URL** pon:
   `https://TU-DOMINIO/legal/terminos`
5. En **Privacy Policy URL** pon:
   `https://TU-DOMINIO/legal/privacidad`
   (reemplaza `TU-DOMINIO` por el dominio real donde corre la app, p. ej.
   `app.merchantai.com`).
6. Guarda.

Resultado: el `<SignUp>` mostrará automáticamente
**"Acepto los Términos de Servicio y la Política de Privacidad"** como casilla
**obligatoria**. Clerk registra el consentimiento en el usuario
(`user.legalAcceptedAt`), así queda la prueba de aceptación con fecha.

> Nota: esto se configura por entorno. Si tienes instancia de **desarrollo** y de
> **producción** en Clerk, actívalo en ambas y usa la URL correspondiente.

## Verificación

1. Abre el registro en una ventana de incógnito.
2. Debe aparecer la casilla de aceptación; sin marcarla, el botón de registro
   queda deshabilitado.
3. Los enlaces deben abrir `/legal/terminos` y `/legal/privacidad`.
