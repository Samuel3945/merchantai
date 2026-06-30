import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';

type LegalPageProps = {
  params: Promise<{ locale: string }>;
};

export const metadata: Metadata = {
  title: 'Política de Privacidad — MerchantAI',
  description: 'Política de Tratamiento de Datos Personales de MerchantAI.',
};

export default async function PrivacidadPage(props: LegalPageProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/sign-up" className="text-sm text-muted-foreground hover:underline">
        ← Volver
      </Link>

      <h1 className="mt-4 text-3xl font-semibold">Política de Tratamiento de Datos Personales</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Última actualización: 30 de junio de 2026 · Responsable: Samuel Alzate Tejada
        {' '}
        · samuelalzatetejada@gmail.com
      </p>

      <div className="
        mt-8 space-y-6 text-sm leading-relaxed text-foreground
        [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold
        [&_li]:ml-4 [&_li]:list-disc
        [&_ul]:space-y-1
      "
      >
        <p>
          Esta Política describe cómo MerchantAI recolecta, usa y protege los datos
          personales, en cumplimiento de la Ley 1581 de 2012 y el Decreto 1377 de
          2013 de la República de Colombia.
        </p>

        <h2>1. Datos que tratamos</h2>
        <ul>
          <li>De la cuenta del comercio: nombre, correo, organización y datos de autenticación (gestionados vía Clerk).</li>
          <li>Operativos del negocio: productos, inventario, ventas, clientes, proveedores y fiados que el Cliente ingresa.</li>
          <li>De clientes finales del comercio: los que el Cliente decida registrar (p. ej. nombre, teléfono para delivery/WhatsApp).</li>
          <li>Técnicos: registros de uso, logs y datos necesarios para operar y asegurar el Servicio.</li>
        </ul>

        <h2>2. Finalidades</h2>
        <ul>
          <li>Prestar, operar y mantener el Servicio.</li>
          <li>Autenticar usuarios y controlar el acceso por plan.</li>
          <li>Facturación electrónica ante la DIAN (a través del proveedor MATIAS).</li>
          <li>Notificaciones operativas (p. ej. delivery por WhatsApp).</li>
          <li>Soporte, seguridad, prevención de fraude y mejora del Servicio.</li>
        </ul>

        <h2>3. Encargados y terceros</h2>
        <p>
          Usamos proveedores que actúan como encargados del tratamiento, entre
          ellos: Clerk (identidad), el proveedor de base de datos y alojamiento,
          MATIAS (facturación electrónica DIAN) y proveedores de IA. Tratan los
          datos según nuestras instrucciones y sus propias políticas.
        </p>

        <h2>4. Derechos del titular (Habeas Data)</h2>
        <p>
          Usted puede conocer, actualizar, rectificar y suprimir sus datos, así
          como revocar la autorización, escribiendo a samuelalzatetejada@gmail.com.
          Atenderemos las solicitudes en los plazos legales.
        </p>

        <h2>5. Seguridad</h2>
        <p>
          Aplicamos medidas técnicas y administrativas razonables (control de
          acceso, aislamiento por organización/tenant, cifrado en tránsito) para
          proteger los datos. Ningún sistema es completamente infalible.
        </p>

        <h2>6. Conservación</h2>
        <p>
          Conservamos los datos mientras la cuenta esté activa y durante los plazos
          legales o contables exigibles. Tras ello se eliminan o anonimizan.
        </p>

        <h2>7. Cambios</h2>
        <p>
          Podemos actualizar esta Política. Publicaremos la versión vigente y
          notificaremos los cambios relevantes.
        </p>

        <p className="pt-4 text-muted-foreground">
          Para ejercer derechos o resolver dudas: samuelalzatetejada@gmail.com
        </p>
      </div>
    </main>
  );
}
