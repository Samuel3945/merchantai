# Aceptación de Términos en el registro

Objetivo: que **al registrarse**, todo usuario acepte los Términos y la Política
de Privacidad. No se hace en el onboarding, sino en el formulario de registro
(Clerk `<SignUp>`).

## Fuente única de los términos

Los Términos y la Política de Privacidad **canónicos** viven en el sitio público
`pagemerchantai` (mymerchantai.com):

- `https://mymerchantai.com/terminos`
- `https://mymerchantai.com/privacidad`

NO se duplican en esta app. (Hubo unas páginas `/legal/*` provisionales en la app;
se eliminaron para no tener dos versiones divergentes.)

## Lo que ya quedó en el código (de esta app)

- **Aviso con enlaces** debajo del formulario de registro
  (`.../sign-up/[[...sign-up]]/page.tsx`): "Al registrarte aceptas nuestros
  Términos de Servicio… y Política de Privacidad…", apuntando a las URLs de
  mymerchantai.com.

## El paso que falta (1 sola vez, en el panel de Clerk)

El formulario de registro lo dibuja Clerk. Para que muestre un **checkbox
obligatorio** de aceptación (no solo el aviso de texto), hay que activar el
consentimiento legal en el dashboard de Clerk:

1. Entra a **dashboard.clerk.com** → tu aplicación (la de producción).
2. Ve a **Configure → User & Authentication → Legal consent**
   (en algunas versiones: **Configure → Legal**).
3. Activa **"Require express consent to legal documents"**.
4. En **Terms of Service URL** pon:
   `https://mymerchantai.com/terminos`
5. En **Privacy Policy URL** pon:
   `https://mymerchantai.com/privacidad`
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
3. Los enlaces deben abrir `https://mymerchantai.com/terminos` y `/privacidad`.
