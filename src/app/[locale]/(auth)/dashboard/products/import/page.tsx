import { setRequestLocale } from 'next-intl/server';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { listCategories } from '@/features/products/actions';
import { ImportClient } from '@/features/products/ImportClient';
import { Link } from '@/libs/I18nNavigation';

export default async function ImportProductsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const categories = await listCategories();

  return (
    <>
      <TitleBar
        title="Importar productos"
        description="Subí un CSV, revisá y corregí cada fila antes de cargar el catálogo."
      />
      <Link
        href="/dashboard/products"
        className="
          mb-4 inline-block text-sm text-muted-foreground
          hover:text-foreground
        "
      >
        ← Volver a productos
      </Link>
      <ImportClient categoryNames={categories.map(c => c.name)} />
    </>
  );
}

export const dynamic = 'force-dynamic';
