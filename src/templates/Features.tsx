import { useTranslations } from 'next-intl';
import { Background } from '@/components/Background';
import { FeatureCard } from '@/features/landing/FeatureCard';
import { Section } from '@/features/landing/Section';

const iconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const features = [
  {
    // Punto de venta veloz — carrito de compras
    titleKey: 'feature1_title',
    descriptionKey: 'feature1_description',
    icon: (
      <svg {...iconProps}>
        <path d="M0 0h24v24H0z" stroke="none" />
        <path d="M6 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
        <path d="M17 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
        <path d="M17 17h-11v-14h-2" />
        <path d="M6 5l14 1l-1 7h-13" />
      </svg>
    ),
  },
  {
    // Inventario en tiempo real — caja / paquete
    titleKey: 'feature2_title',
    descriptionKey: 'feature2_description',
    icon: (
      <svg {...iconProps}>
        <path d="M0 0h24v24H0z" stroke="none" />
        <path d="M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9l8 -4.5" />
        <path d="M12 12l8 -4.5" />
        <path d="M12 12v9" />
        <path d="M12 12l-8 -4.5" />
        <path d="M16 5.25l-8 4.5" />
      </svg>
    ),
  },
  {
    // Fiados — tarjeta de crédito
    titleKey: 'feature3_title',
    descriptionKey: 'feature3_description',
    icon: (
      <svg {...iconProps}>
        <path d="M0 0h24v24H0z" stroke="none" />
        <path d="M3 5m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" />
        <path d="M3 10l18 0" />
        <path d="M7 15l.01 0" />
        <path d="M11 15l2 0" />
      </svg>
    ),
  },
  {
    // Sales Manager AI — gráfico de barras
    titleKey: 'feature4_title',
    descriptionKey: 'feature4_description',
    icon: (
      <svg {...iconProps}>
        <path d="M0 0h24v24H0z" stroke="none" />
        <path d="M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />
        <path d="M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />
        <path d="M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />
        <path d="M4 20l14 0" />
      </svg>
    ),
  },
  {
    // Asistente de atención al cliente — chat
    titleKey: 'feature5_title',
    descriptionKey: 'feature5_description',
    icon: (
      <svg {...iconProps}>
        <path d="M0 0h24v24H0z" stroke="none" />
        <path d="M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10" />
        <path d="M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2" />
      </svg>
    ),
  },
  {
    // Reportes — documento con analítica
    titleKey: 'feature6_title',
    descriptionKey: 'feature6_description',
    icon: (
      <svg {...iconProps}>
        <path d="M0 0h24v24H0z" stroke="none" />
        <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" />
        <path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" />
        <path d="M9 17v-2" />
        <path d="M12 17v-4" />
        <path d="M15 17v-6" />
      </svg>
    ),
  },
] as const;

export const Features = () => {
  const t = useTranslations('Features');

  return (
    <Background>
      <Section
        id="features"
        subtitle={t('section_subtitle')}
        title={t('section_title')}
        description={t('section_description')}
      >
        <div className="
          grid grid-cols-1 gap-x-3 gap-y-8
          md:grid-cols-3
        "
        >
          {features.map(feature => (
            <FeatureCard
              key={feature.titleKey}
              icon={feature.icon}
              title={t(feature.titleKey)}
            >
              {t(feature.descriptionKey)}
            </FeatureCard>
          ))}
        </div>
      </Section>
    </Background>
  );
};
