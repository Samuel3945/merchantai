import { cn } from '@/utils/Helpers';

export const Section = (props: {
  children: React.ReactNode;
  id?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  className?: string;
}) => (
  <div id={props.id} className={cn('@container scroll-mt-20 px-3 py-16', props.className)}>
    {(props.title || props.subtitle || props.description) && (
      <div className="mx-auto mb-12 max-w-3xl text-center">
        {props.subtitle && (
          <div className="
            bg-linear-to-r from-primary to-brand-ink bg-clip-text text-sm
            font-bold tracking-wide text-transparent uppercase
          "
          >
            {props.subtitle}
          </div>
        )}

        {props.title && (
          <div className="mt-1 text-3xl font-bold">{props.title}</div>
        )}

        {props.description && (
          <div className="mt-2 text-lg text-muted-foreground">
            {props.description}
          </div>
        )}
      </div>
    )}

    <div className="mx-auto max-w-5xl">{props.children}</div>
  </div>
);
