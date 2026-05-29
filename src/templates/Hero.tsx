import { ArrowRightIcon, MagicWandIcon } from '@radix-ui/react-icons';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/buttonVariants';
import { CenteredHero } from '@/features/landing/CenteredHero';
import { Section } from '@/features/landing/Section';
import { Link } from '@/libs/I18nNavigation';

export const Hero = () => {
  const t = useTranslations('Hero');

  return (
    <Section className="py-36">
      <CenteredHero
        banner={(
          <span className="
            inline-flex items-center gap-1.5 rounded-full border border-border
            bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground
          "
          >
            <MagicWandIcon className="size-4 text-purple-500" />
            {t('badge')}
          </span>
        )}
        title={t.rich('title', {
          important: chunks => (
            <span className="
              bg-linear-to-r from-indigo-500 via-purple-500 to-pink-500
              bg-clip-text text-transparent
            "
            >
              {chunks}
            </span>
          ),
        })}
        description={t('description')}
        buttons={(
          <>
            <Link
              className={buttonVariants({ size: 'lg' })}
              href="/sign-up"
            >
              {t('primary_button')}
              <ArrowRightIcon className="ml-1 size-5" />
            </Link>

            <a
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
              href="#features"
            >
              {t('secondary_button')}
            </a>
          </>
        )}
      />
    </Section>
  );
};
