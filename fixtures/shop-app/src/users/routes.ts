import express from 'express';
import { requireAuth } from '../auth/middleware.ts';
import type { AuthenticatedRequest, Response } from '../auth/middleware.ts';

export const usersRouter = express.Router();

usersRouter.get('/me', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  res.json(_req.user);
});