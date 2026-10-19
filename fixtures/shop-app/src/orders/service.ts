import { repo } from '../db/memory.ts';
import { cartService } from '../cart/service.ts';
import { chargePayment } from '../payments/stripe.ts';
import { sendOrderConfirmation } from '../notifications/email.ts';
import { calculateSubtotal, calculateTax, calculateTotal } from './pricing.ts';
import { generateId } from '../db/memory.ts';

export const ordersService = {
  async checkout(userId: string) {
    const cart = await cartService.getCart(userId);
    if (!cart || cart.items.length === 0) {
      throw new Error('Cart is empty');
    }

    const orderItems = [];
    for (const item of cart.items) {
      const product = repo.products.findById(item.productId);
      if (!product) throw new Error(`Product ${item.productId} not found`);
      if (product.stock < item.quantity) throw new Error(`Insufficient stock for ${product.name}`);

      orderItems.push({
        productId: product.id,
        quantity: item.quantity,
        unitPrice: product.price,
      });

      repo.products.updateStock(product.id, -item.quantity);
    }

    const subtotal = calculateSubtotal(orderItems);
    const tax = calculateTax(subtotal);
    const total = calculateTotal(subtotal);

    const orderId = generateId('ord');
    const order = {
      id: orderId,
      userId,
      items: orderItems,
      total,
      tax,
      status: 'pending' as const,
      createdAt: new Date(),
    };

    const createdOrder = repo.orders.create(order);

    const chargeResult = await chargePayment(total, 'usd', `Order ${orderId}`, { orderId, userId });

    const payment = {
      id: generateId('pay'),
      orderId,
      amount: total,
      status: chargeResult.status,
      provider: chargeResult.provider,
      providerChargeId: chargeResult.providerChargeId,
    };
    repo.payments.create(payment);

    if (chargeResult.status === 'succeeded') {
      repo.orders.updateStatus(orderId, 'paid');
      createdOrder.status = 'paid';
      createdOrder.payment = payment;

      const user = repo.users.findById(userId);
      if (user) {
        await sendOrderConfirmation({
          orderId,
          userEmail: user.email,
          userName: user.name,
          items: orderItems.map(i => ({
            name: repo.products.findById(i.productId)?.name ?? 'Unknown',
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
          subtotal,
          tax,
          total,
        });
      }
    } else {
      repo.orders.updateStatus(orderId, 'cancelled');
      createdOrder.status = 'cancelled';
      createdOrder.payment = payment;

      for (const item of orderItems) {
        repo.products.updateStock(item.productId, item.quantity);
      }
    }

    await cartService.clearCart(userId);

    return createdOrder;
  },

  async getOrderById(orderId: string, userId: string) {
    const order = repo.orders.findById(orderId);
    if (!order || order.userId !== userId) return undefined;
    const payment = repo.payments.findByOrderId(orderId);
    return { ...order, payment };
  },

  async cancelOrder(orderId: string, userId: string) {
    const order = repo.orders.findById(orderId);
    if (!order || order.userId !== userId) throw new Error('Order not found');
    if (order.status !== 'paid') throw new Error('Only paid orders can be cancelled');

    const hoursSinceCreation = (Date.now() - order.createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreation >= 24) throw new Error('Cancellation window expired (24 hours)');

    for (const item of order.items) {
      repo.products.updateStock(item.productId, item.quantity);
    }

    repo.orders.updateStatus(orderId, 'cancelled');
    const payment = repo.payments.findByOrderId(orderId);
    if (payment) {
      repo.payments.updateStatus(payment.id, 'failed');
    }

    const updatedOrder = repo.orders.findById(orderId);
    return { ...updatedOrder!, payment: { ...payment!, status: 'failed' as const } };
  },
};