// Pure maths for the cost calculator (no DOM, no imports: also runs in the Worker and in Node tests).

/**
 * Rough pre-slice weight in grams: a shell of the given thickness over the whole surface (capped at the
 * volume) plus the rest of the volume at the infill percentage. Ignores supports, brim and purge.
 */
export function shellWeight(volumeCm3, areaCm2, wallMm, infillPct, density) {
  const shell = Math.min((areaCm2 * wallMm) / 10, volumeCm3);
  return (shell + ((volumeCm3 - shell) * infillPct) / 100) * density;
}

/** Cost breakdown. Every optional input defaults to 0. Failure allowance applies to filament + electricity + wear. */
export function computeCost({ grams, pricePerKg, hours = 0, watts = 0, kwhPrice = 0, wearPerHour = 0, failPct = 0, labourRate = 0, labourMin = 0, marginPct = 0, feePct = 0 }) {
  const filament = (grams / 1000) * pricePerKg;
  const electricity = (watts / 1000) * hours * kwhPrice;
  const wear = wearPerHour * hours;
  const failure = ((filament + electricity + wear) * failPct) / 100;
  const labour = (labourRate * labourMin) / 60;
  const total = filament + electricity + wear + failure + labour;
  const margin = (total * marginPct) / 100;
  const price = (total + margin) / (1 - feePct / 100); // the fee is a share of the selling price
  return { filament, electricity, wear, failure, labour, total, margin, fee: price - total - margin, price };
}
