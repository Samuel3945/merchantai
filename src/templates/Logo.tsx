/**
 * Logo de MyMerchant AI.
 * Marca oficial: toldo de tienda + "M" + flecha de crecimiento.
 * Colores del logo: navy #0f2a43 (texto "MyMerchant") y teal #14a98a (icono + "AI").
 */
export const Logo = (props: { isTextHidden?: boolean }) => (
  <div className="flex items-center gap-2">
    <svg
      className="size-9 shrink-0"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Techo / toldo de la tienda */}
      <path
        d="M11 25 L32 12 L53 25"
        stroke="#0f2a43"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Borde ondulado del toldo */}
      <path
        d="M13 25 q3.5 5 7 0 q3.5 5 7 0 q3.5 5 7 0 q3.5 5 7 0 q3.5 5 7 0"
        stroke="#0f2a43"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Patas que forman la M */}
      <path
        d="M16 31 L16 51 M16 51 L25 37 L33 47"
        stroke="#0f2a43"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Flecha de crecimiento */}
      <path
        d="M29 47 L47 28 M47 28 L38 28 M47 28 L47 37"
        stroke="#14a98a"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    {!props.isTextHidden && (
      <span className="text-xl font-extrabold tracking-tight text-[#0f2a43]">
        MyMerchant
        <span className="text-[#14a98a]">
          {' '}
          AI
        </span>
      </span>
    )}
  </div>
);
