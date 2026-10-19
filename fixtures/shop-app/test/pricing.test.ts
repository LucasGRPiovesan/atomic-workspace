import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateSubtotal, calculateTax, calculateTotal, TAX_RATE } from '../src/orders/pricing.ts';

describe('pricing', () => {
  describe('calculateSubtotal', () => {
    it('returns 0 for empty items', () => {
      assert.strictEqual(calculateSubtotal([]), 0);
    });

    it('calculates subtotal for single item', () => {
      const items = [{ unitPrice: 100, quantity: 2 }];
      assert.strictEqual(calculateSubtotal(items), 200);
    });

    it('calculates subtotal for multiple items', () => {
      const items = [
        { unitPrice: 100, quantity: 2 },
        { unitPrice: 50, quantity: 3 },
      ];
      assert.strictEqual(calculateSubtotal(items), 350);
    });

    it('handles decimal prices', () => {
      const items = [{ unitPrice: 19.99, quantity: 3 }];
      assert.strictEqual(calculateSubtotal(items), 59.97);
    });
  });

  describe('calculateTax', () => {
    it('returns 0 for zero subtotal', () => {
      assert.strictEqual(calculateTax(0), 0);
    });

    it('calculates 19% tax rounded to 2 decimals', () => {
      assert.strictEqual(calculateTax(100), 19);
    });

    it('rounds correctly for decimal results', () => {
      assert.strictEqual(calculateTax(10), 1.9);
      assert.strictEqual(calculateTax(33.33), 6.33);
    });
  });

  describe('calculateTotal', () => {
    it('returns subtotal + tax', () => {
      assert.strictEqual(calculateTotal(100), 119);
    });

    it('handles zero', () => {
      assert.strictEqual(calculateTotal(0), 0);
    });
  });

  describe('TAX_RATE constant', () => {
    it('is 0.19', () => {
      assert.strictEqual(TAX_RATE, 0.19);
    });
  });
});