// Alias singular `/api/pos/sale` → reusa el handler de `/api/pos/sales`.
// TiendaCajero (POS de cajero) hace checkout online contra `/pos/sale`; el
// admin y el sync usan `/pos/sales`. Misma lógica, un solo origen de verdad.
export { POST } from '../sales/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
