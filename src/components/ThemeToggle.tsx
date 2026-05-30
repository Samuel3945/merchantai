'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Switch de tema claro/oscuro. La clase `.dark` se aplica al <html>; el tema
 * inicial lo fija ThemeScript antes de la hidratación, así que aquí solo
 * leemos el estado actual y lo alternamos, persistiendo en localStorage.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('tc-theme', next ? 'dark' : 'light');
    } catch {
      // ignore (modo privado / storage bloqueado)
    }
  };

  // Antes de montar renderizamos el ícono neutro (luna) para evitar mismatch.
  const showSun = mounted && dark;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={showSun ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      title={showSun ? 'Modo claro' : 'Modo oscuro'}
    >
      {showSun
        ? <Sun className="size-[18px]" />
        : <Moon className="size-[18px]" />}
    </Button>
  );
}
