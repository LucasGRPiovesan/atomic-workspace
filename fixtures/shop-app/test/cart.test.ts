import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { cartService } from '../src/cart/service.ts';
import { repo, resetDB } from '../src/db/memory.ts';

describe('cart service', () => {
  beforeEach(() => resetDB());
  afterEach(() => resetDB());

  describe('getCart', () => {
    it('returns empty cart for new user', async () => {
      const cart = await cartService.getCart('u1');
      assert.deepStrictEqual(cart, { userId: 'u1', items: [] });
    });

    it('returns existing cart with items', async () => {
      await cartService.addItem('u1', 'p1', 2);
      const cart = await cartService.getCart('u1');
      assert.strictEqual(cart.items.length, 1);
      assert.strictEqual(cart.items[0].productId, 'p1');
      assert.strictEqual(cart.items[0].quantity, 2);
    });
  });

  describe('addItem', () => {
    it('adds new item to empty cart', async () => {
      const cart = await cartService.addItem('u1', 'p1', 1);
      assert.strictEqual(cart.items.length, 1);
      assert.strictEqual(cart.items[0].productId, 'p1');
      assert.strictEqual(cart.items[0].quantity, 1);
    });

    it('increments quantity for existing product', async () => {
      await cartService.addItem('u1', 'p1', 1);
      const cart = await cartService.addItem('u1', 'p1', 2);
      assert.strictEqual(cart.items.length, 1);
      assert.strictEqual(cart.items[0].quantity, 3);
    });

    it('throws for non-existent product', async () => {
      await assert.rejects(
        cartService.addItem('u1', 'nonexistent', 1),
        /Product not found/
      );
    });

    it('throws for insufficient stock', async () => {
      await assert.rejects(
        cartService.addItem('u1', 'p1', 999),
        /Insufficient stock/
      );
    });

    it('throws for zero or negative quantity', async () => {
      await assert.rejects(
        cartService.addItem('u1', 'p1', 0),
        /Quantity must be positive/
      );
      await assert.rejects(
        cartService.addItem('u1', 'p1', -1),
        /Quantity must be positive/
      );
    });

    it('respects stock limits when adding to existing item', async () => {
      await cartService.addItem('u1', 'p1', 5);
      await assert.rejects(
        cartService.addItem('u1', 'p1', 6),
        /Insufficient stock/
      );
    });
  });

  describe('removeItem', () => {
    it('removes item from cart', async () => {
      await cartService.addItem('u1', 'p1', 2);
      await cartService.addItem('u1', 'p2', 1);
      const cart = await cartService.removeItem('u1', 'p1');
      assert.strictEqual(cart.items.length, 1);
      assert.strictEqual(cart.items[0].productId, 'p2');
    });

    it('does nothing if item not in cart', async () => {
      await cartService.addItem('u1', 'p1', 1);
      const cart = await cartService.removeItem('u1', 'p999');
      assert.strictEqual(cart.items.length, 1);
    });

    it('returns empty cart for user without cart', async () => {
      const cart = await cartService.removeItem('u1', 'p1');
      assert.deepStrictEqual(cart, { userId: 'u1', items: [] });
    });
  });

  describe('clearCart', () => {
    it('empties the cart', async () => {
      await cartService.addItem('u1', 'p1', 3);
      await cartService.clearCart('u1');
      const cart = await cartService.getCart('u1');
      assert.strictEqual(cart.items.length, 0);
    });
  });
});