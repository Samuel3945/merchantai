'use client';

import { Link, usePathname } from '@/libs/I18nNavigation';
import { cn } from '@/utils/Helpers';

export const ActiveLink = (props: {
  href: string;
  children: React.ReactNode;
  badge?: 'red' | null;
}) => {
  const pathname = usePathname();

  return (
    <Link
      href={props.href}
      className={cn(
        'relative inline-flex items-center px-3 py-2',
        pathname.endsWith(props.href)
        && 'rounded-md bg-primary text-primary-foreground',
      )}
    >
      {props.children}
      {props.badge === 'red' && (
        <span
          className="
            ml-1.5 inline-block size-2 rounded-full bg-red-600 ring-2
            ring-background
          "
          aria-label="Alerta de fraude"
          title="Alerta de fraude"
        />
      )}
    </Link>
  );
};
