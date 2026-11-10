import test from 'node:test';
import assert from 'node:assert/strict';
import { shellWeight, computeCost } from '../src/tools/print-cost-calculator/calc.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('shell + infill estimate matches the old calculator', () => {
  // 20 mm cube = 8 cm³, 24 cm². Old page: wall 2 mm, 20 %, 1.24 -> 6.75 g; 100 % -> 9.92 g
  near(shellWeight(8, 24, 2, 20, 1.24), 6.7456);
  near(shellWeight(8, 24, 2, 100, 1.24), 9.92);
  near(shellWeight(8, 24, 50, 0, 1.24), 9.92); // shell is capped at the volume
  near(shellWeight(8, 24, 0, 0, 1.24), 0);
});

test('cost: filament only', () => {
  const c = computeCost({ grams: 497.92, pricePerKg: 20000 });
  near(c.filament, 9958.4);
  near(c.total, 9958.4);
  near(c.price, 9958.4);
  assert.equal(c.electricity + c.wear + c.failure + c.labour + c.margin + c.fee, 0);
});

test('cost: every option', () => {
  const c = computeCost({ grams: 100, pricePerKg: 20, hours: 10, watts: 150, kwhPrice: 0.2, wearPerHour: 0.1, failPct: 10, labourRate: 12, labourMin: 30, marginPct: 50, feePct: 20 });
  near(c.filament, 2);
  near(c.electricity, 0.3);
  near(c.wear, 1);
  near(c.failure, 0.33); // 10 % of 3.30, labour excluded
  near(c.labour, 6);
  near(c.total, 9.63);
  near(c.margin, 4.815);
  near(c.price, 14.445 / 0.8);
  near(c.price - c.fee, c.total + c.margin); // what is left after the marketplace takes 20 % of the price
});
