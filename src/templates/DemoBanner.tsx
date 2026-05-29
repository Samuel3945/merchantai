import { StickyBanner } from '@/features/landing/StickyBanner';
import { Link } from '@/libs/I18nNavigation';

export const DemoBanner = () => (
  <StickyBanner>
    Nuevo: pregúntale a tu negocio con Sales Manager AI —
    {' '}
    <Link href="/sign-up">empieza gratis hoy</Link>
  </StickyBanner>
);
