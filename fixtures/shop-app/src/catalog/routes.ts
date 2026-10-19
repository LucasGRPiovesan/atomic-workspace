import express from 'express';
import type { Request, Response } from 'express';
import { catalogService } from './service.ts';

export const catalogRouter = express.Router();

catalogRouter.get('/products', async (_req: Request, res: Response) => {
  const products = await catalogService.getAllProducts();
  res.json(products);
});

catalogRouter.get('/products/:id', async (req: Request, res: Response) => {
  const product = await catalogService.getProductById(req.params.id);
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  res.json(product);
});