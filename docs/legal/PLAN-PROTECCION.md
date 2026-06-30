# Plan de protección de MerchantAI

Estado de las acciones para proteger la propiedad del software. MerchantAI es un
**SaaS multi-tenant**: el código corre en el servidor del titular y el cliente
solo accede al servicio — esa arquitectura es la primera y principal barrera.

## Capa 1 — Legal del código (HECHO ✅)

- [x] Reemplazar la licencia MIT del boilerplate por una **licencia propietaria**
      ("todos los derechos reservados") → `LICENSE`.
- [x] Corregir `package.json`: `name=merchantai`, `author`, `license=UNLICENSED`,
      `private=true`.
- [x] Aviso de propiedad → `NOTICE`.
- [x] Nota de propiedad en `README.md`.
- [x] Cabeceras de copyright en módulos núcleo (`entitlements`, `creditos`,
      `fifo-cogs`, `smart-stock`, `einvoice/matias-adapter`, `einvoice/emit`).

## Capa 2 — Legal de cara al cliente (HECHO ✅)

- [x] Términos y Condiciones de Servicio → `docs/legal/TERMINOS.md`.
- [x] Política de Tratamiento de Datos (Ley 1581) → `docs/legal/PRIVACIDAD.md`.

### Pendiente de integración en producto (tú decides cuándo)

- [ ] Mostrar y exigir **aceptación de los Términos** en el registro/onboarding
      (checkbox + guardar fecha/versión aceptada por organización).
- [ ] Enlazar Términos y Privacidad en el footer de la landing pública.

## Capa 3 — Técnica (REVISADO ✅)

- [x] Auditoría del control de acceso (`src/libs/entitlements.ts`,
      `creditos.ts`, `plan-limits.ts`): los entitlements se resuelven **del lado
      del servidor** desde la BD, con fallback seguro a plan `free`, y se aplican
      en Server Actions. **No es eludible desde el cliente.** Arquitectura correcta.

### Refuerzos técnicos recomendados (opcionales, futuros)

- [ ] Repositorio **privado** en GitHub (verificar visibilidad) y acceso mínimo.
- [ ] Rotación y manejo de secretos en variables de entorno (nunca en el repo).
- [ ] Rate limiting / protección anti-scraping en endpoints públicos.
- [ ] Si algún día se distribuye una versión **instalable** (no SaaS): diseñar
      **license keys firmadas** (JWT/RSA) con activación online y validación por
      dispositivo. Para el SaaS actual NO es necesario.

## Acciones legales externas (dependen de ti, fuera del código)

- [ ] **Registro en la DNDA** (Dirección Nacional de Derecho de Autor) del
      software como obra, para tener prueba de fecha y autoría ante un litigio.
      El copyright ya existe automáticamente; el registro solo lo refuerza.
- [ ] Definir si el titular será **persona natural** (actual: Samuel Alzate
      Tejada) o una **empresa/SAS** a futuro; si se crea empresa, actualizar
      `LICENSE`, `NOTICE`, `package.json` y documentos legales al nuevo titular.
- [ ] (Opcional) Asesoría de un abogado para revisar los Términos antes de
      lanzamiento comercial.

---

Titular actual: **Samuel Alzate Tejada** — samuelalzatetejada@gmail.com
Última actualización del plan: 30 de junio de 2026
