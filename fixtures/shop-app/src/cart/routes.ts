import express from 'express';
import { cartService } from './service.ts';
import { requireAuth } from '../auth/middleware.ts';
import type { AuthenticatedRequest, Response } from '../auth/middleware.ts';

export const cartRouter = express.Router();

cartRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const cart = await cartService.getCart(req.user!.id);
  res.json(cart);
});

cartRouter.post('/items', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { productId, quantity = 1 } = req.body as { productId: string; quantity?: number };
  if (!productId) {
    res.status(400).json({ error: 'productId is required' });
    return;
  }
  try {
    const cart = await cartService.addItem(req.user!.id, productId, quantity);
    res.status(201).json(cart);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add item';
    res.status(400).json({ error: message });
  }
});

cartRouter.delete('/items/:productId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const cart = await cartService.removeItem(req.user!.id, req.params.productId);
  res.json(cart);
});