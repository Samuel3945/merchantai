import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export const MobileNavigation = (props: {
  menu: {
    href: string;
    label: string;
    badge?: 'red' | null;
  }[];
}) => {
  const hasAnyRedBadge = props.menu.some(item => item.badge === 'red');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="
            relative p-2
            focus-visible:ring-offset-0
          "
          variant="ghost"
        >
          <svg
            className="size-6 stroke-current"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M0 0h24v24H0z" stroke="none" />
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {hasAnyRedBadge && (
            <span
              className="
                absolute top-1 right-1 size-2 rounded-full bg-red-600 ring-2
                ring-background
              "
              aria-label="Alerta de fraude"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {props.menu.map(item => (
          <DropdownMenuItem key={item.href} asChild>
            <Link
              href={item.href}
              className="flex items-center justify-between gap-2"
            >
              <span>{item.label}</span>
              {item.badge === 'red' && (
                <span
                  className="size-2 rounded-full bg-red-600"
                  aria-label="Alerta de fraude"
                />
              )}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
