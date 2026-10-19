import express from 'express';
import { catalogRouter } from '../catalog/routes.ts';
import { cartRouter } from '../cart/routes.ts';
import { ordersRouter } from '../orders/routes.ts';
import { usersRouter } from '../users/routes.ts';

export const apiRouter = express.Router();

apiRouter.use('/', catalogRouter);
apiRouter.use('/cart', cartRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/me', usersRouter);