import { repo } from '../db/memory.ts';

export const cartService = {
  async getCart(userId: string) {
    return repo.carts.findByUserId(userId) ?? { userId, items: [] };
  },

  async addItem(userId: string, productId: string, quantity: number) {
    if (quantity <= 0) throw new Error('Quantity must be positive');

    const product = repo.products.findById(productId);
    if (!product) throw new Error('Product not found');
    if (product.stock < quantity) throw new Error('Insufficient stock');

    let cart = repo.carts.findByUserId(userId);
    if (!cart) {
      cart = { userId, items: [] };
    }

    const existingItem = cart.items.find(i => i.productId === productId);
    const newQuantity = (existingItem?.quantity ?? 0) + quantity;

    if (product.stock < newQuantity) throw new Error('Insufficient stock');

    if (existingItem) {
      existingItem.quantity = newQuantity;
    } else {
      cart.items.push({ productId, quantity: newQuantity });
    }

    return repo.carts.upsert(cart);
  },

  async removeItem(userId: string, productId: string) {
    const cart = repo.carts.findByUserId(userId);
    if (!cart) return { userId, items: [] };

    cart.items = cart.items.filter(i => i.productId !== productId);
    return repo.carts.upsert(cart);
  },

  async clearCart(userId: string) {
    repo.carts.clear(userId);
    return { userId, items: [] };
  },
};