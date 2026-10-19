import express from 'express';
import { ordersService } from './service.ts';
import { requireAuth } from '../auth/middleware.ts';
import type { AuthenticatedRequest, Response } from '../auth/middleware.ts';

export const ordersRouter = express.Router();

ordersRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await ordersService.checkout(req.user!.id);
    res.status(201).json(order);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed';
    const status = message.includes('empty') || message.includes('stock') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

ordersRouter.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const order = await ordersService.getOrderById(req.params.id, req.user!.id);
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json(order);
});

ordersRouter.post('/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await ordersService.cancelOrder(req.params.id, req.user!.id);
    res.json(order);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Cancellation failed';
    const status = message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: message });
  }
});