// Smart Stock heuristic — deterministic, NOT an LLM.
//
// Lives in a plain lib (not a "use server" module) so the math can be shared by
// the per-product suggestion path and the bulk recompute that runs when a Pro
// org turns Smart Stock on. A "use server" file may only export async functions,
// so these synchronous helpers cannot live alongside the actions.
//
// The model: minimum stock = how much we sell during the supplier lead time,
// padded by a safety factor so a sales spike doesn't stock us out before the
// next purchase lands. avgDaily comes from a fixed 30-day window of sold units.

export const SMART_STOCK_LEAD_TIME_DAYS = 3;
export const SMART_STOCK_SAFETY_FACTOR = 1.5;
export const SMART_STOCK_SALES_WINDOW_DAYS = 30;

// app_settings key holding the per-org on/off flag. Value is the string 'true'
// or 'false' — app_settings stores text.
export const SMART_STOCK_SETTING_KEY = 'smartStockEnabled';

export type PlanName = 'free' | 'starter' | 'pro' | 'business';

// Smart Stock is a paid model: only Pro and Business unlock the automatic
// minimum-stock manager. Everyone else edits the minimum by hand.
export function isProPlan(plan: string): boolean {
  return plan === 'pro' || plan === 'business';
}

export type SmartStockComputation = {
  avgDailySales: number;
  avgWeeklySales: number;
  suggestedMinStock: number;
  suggestedMaxStock: number;
  leadTimeDays: number;
  reasoning: string;
};

// Given the units sold across the trailing window, derive the suggested min/max.
// Pure function: no DB, no clock — the caller supplies the window total so this
// stays trivially testable and identical between single and bulk paths.
export function computeSmartStock(
  totalQtyInWindow: number,
  windowDays: number = SMART_STOCK_SALES_WINDOW_DAYS,
): SmartStockComputation {
  const safeWindow = windowDays > 0 ? windowDays : SMART_STOCK_SALES_WINDOW_DAYS;
  const avgDaily = Math.max(0, totalQtyInWindow) / safeWindow;
  const avgWeekly = avgDaily * 7;

  const suggestedMinStock = Math.ceil(
    avgDaily * SMART_STOCK_LEAD_TIME_DAYS * SMART_STOCK_SAFETY_FACTOR,
  );
  const suggestedMaxStock = Math.ceil(
    avgDaily * SMART_STOCK_LEAD_TIME_DAYS * 3,
  );

  let reasoning: string;
  if (avgDaily === 0) {
    reasoning
      = `Sin ventas en los últimos ${safeWindow} días. Mínimo de seguridad sugerido: `
        + `${suggestedMinStock} unidades.`;
  } else {
    reasoning
      = `Vendés ~${avgWeekly.toFixed(1)} unidades/semana (${totalQtyInWindow} en `
        + `${safeWindow} días). Con un lead time de ${SMART_STOCK_LEAD_TIME_DAYS} días `
        + `y factor de seguridad ×${SMART_STOCK_SAFETY_FACTOR}, el mínimo sugerido es `
        + `${suggestedMinStock}.`;
  }

  return {
    avgDailySales: Math.round(avgDaily * 10) / 10,
    avgWeeklySales: Math.round(avgWeekly * 10) / 10,
    suggestedMinStock,
    suggestedMaxStock,
    leadTimeDays: SMART_STOCK_LEAD_TIME_DAYS,
    reasoning,
  };
}
