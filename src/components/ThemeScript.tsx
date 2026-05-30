/**
 * Aplica el tema (claro/oscuro) ANTES de la hidratación para evitar el flash
 * de color (FOUC). Lee la preferencia guardada en localStorage('tc-theme') y,
 * si no hay, respeta la del sistema. El <html> ya tiene suppressHydrationWarning.
 */
export function ThemeScript() {
  const code = `(function(){try{var s=localStorage.getItem('tc-theme');var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

  // eslint-disable-next-line react/dom-no-dangerously-set-innerhtml
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
