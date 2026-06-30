import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';

type LegalPageProps = {
  params: Promise<{ locale: string }>;
};

export const metadata: Metadata = {
  title: 'Términos y Condiciones — MerchantAI',
  description: 'Términos y Condiciones de Servicio de MerchantAI.',
};

export default async function TerminosPage(props: LegalPageProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/sign-up" className="text-sm text-muted-foreground hover:underline">
        ← Volver
      </Link>

      <h1 className="mt-4 text-3xl font-semibold">Términos y Condiciones de Servicio</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Última actualización: 30 de junio de 2026 · Titular: Samuel Alzate Tejada
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
          Estos Términos y Condiciones (los «Términos») regulan el acceso y uso de
          la plataforma MerchantAI (el «Servicio»). Al registrarse, acceder o usar
          el Servicio, el usuario («Usted», el «Cliente») acepta quedar obligado
          por estos Términos. Si no está de acuerdo, no use el Servicio.
        </p>

        <h2>1. Descripción del Servicio</h2>
        <p>
          MerchantAI es un software como servicio (SaaS) de gestión para comercios
          que incluye punto de venta (POS), inventario, ventas, fiados, reportes,
          facturación electrónica y funciones de inteligencia artificial, ofrecido
          bajo modelo de suscripción por planes.
        </p>

        <h2>2. Licencia de uso (limitada)</h2>
        <p>
          Sujeto al pago de la suscripción correspondiente y al cumplimiento de
          estos Términos, le otorgamos una licencia personal, limitada, revocable,
          no exclusiva e intransferible para acceder y usar el Servicio con fines
          propios de la operación de su negocio. Esta licencia no transfiere ningún
          derecho de propiedad sobre el software.
        </p>

        <h2>3. Propiedad intelectual</h2>
        <p>
          El Servicio, su software, código fuente y objeto, diseño, marcas,
          interfaces, bases de datos y documentación son propiedad exclusiva del
          Titular y están protegidos por la Ley 23 de 1982, la Decisión Andina 351
          y los tratados internacionales aplicables.
        </p>

        <h2>4. Conductas prohibidas</h2>
        <p>Usted se obliga a NO:</p>
        <ul>
          <li>copiar, reproducir, descompilar, desensamblar o aplicar ingeniería inversa al Servicio ni intentar acceder a su código fuente;</li>
          <li>revender, sublicenciar, alquilar, prestar o poner el Servicio a disposición de terceros ajenos a su organización;</li>
          <li>compartir credenciales de acceso o permitir el uso por personas no autorizadas;</li>
          <li>usar bots, scrapers o medios automatizados para extraer datos o sobrecargar el Servicio;</li>
          <li>eludir límites de plan, controles de acceso, medición de créditos o cualquier medida técnica de protección;</li>
          <li>usar el Servicio para fines ilícitos o en infracción de derechos de terceros.</li>
        </ul>

        <h2>5. Cuentas, planes y créditos</h2>
        <p>
          El acceso a determinadas funciones depende del plan contratado y del
          saldo de créditos. Los límites por plan y el consumo de créditos se
          aplican del lado del servidor y constituyen condiciones del Servicio. Los
          precios y planes pueden cambiar con aviso previo razonable.
        </p>

        <h2>6. Datos del Cliente</h2>
        <p>
          Usted conserva la titularidad de los datos que ingrese. Nos otorga una
          licencia limitada para procesarlos con el único fin de prestar el
          Servicio, conforme a la Política de Privacidad.
        </p>

        <h2>7. Disponibilidad y garantía</h2>
        <p>
          El Servicio se presta «tal cual» y «según disponibilidad». No
          garantizamos operación ininterrumpida ni libre de errores.
        </p>

        <h2>8. Limitación de responsabilidad</h2>
        <p>
          En la máxima medida permitida por la ley, el Titular no será responsable
          por daños indirectos, incidentales o lucro cesante. La responsabilidad
          total agregada no excederá el valor pagado por Usted en los tres (3)
          meses anteriores al hecho que origine la reclamación.
        </p>

        <h2>9. Terminación</h2>
        <p>
          Podemos suspender o terminar el acceso de forma inmediata ante
          incumplimiento de estos Términos. Tras la terminación cesa la licencia de
          uso.
        </p>

        <h2>10. Ley aplicable</h2>
        <p>
          Estos Términos se rigen por las leyes de la República de Colombia. Las
          controversias se someterán a los jueces competentes de Colombia.
        </p>

        <h2>11. Cambios</h2>
        <p>
          Podemos actualizar estos Términos. El uso continuado del Servicio implica
          su aceptación.
        </p>

        <p className="pt-4 text-muted-foreground">
          Contacto: samuelalzatetejada@gmail.com
        </p>
      </div>
    </main>
  );
}
