const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function fmtMoney(value: number): string {
  return moneyFmt.format(value);
}
