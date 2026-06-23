// Movement types as defined by treasury_movement_type in the schema. Kept in
// sync with src/models/Schema.ts#treasuryMovementTypeEnum.
export const TREASURY_MOVEMENT_TYPES = [
  'transfer',
  'consignacion',
  'entrada',
  'salida',
  'gasto',
  'adjustment',
  'handover',
] as const;

// Human labels (es-CO) for each movement type — used in the full-history filter
// and as the row title fallback.
export const TREASURY_MOVEMENT_TYPE_LABELS: Record<string, string> = {
  transfer: 'Movimiento interno',
  consignacion: 'Consignación',
  entrada: 'Entrada',
  salida: 'Salida',
  gasto: 'Gasto',
  adjustment: 'Ajuste',
  handover: 'Entrega de caja',
};

export function movementTypeLabel(type: string): string {
  return TREASURY_MOVEMENT_TYPE_LABELS[type] ?? type;
}
