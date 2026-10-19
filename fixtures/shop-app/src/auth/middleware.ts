import { repo } from '../db/memory.ts';

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  params: Record<string, string>;
  user?: { id: string; email: string; name: string };
};

export type Response = {
  status(code: number): Response;
  json(body: unknown): Response;
};

export type NextFunction = (err?: Error) => void;

export function authMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const userId = req.headers['x-user'] as string | undefined;
  if (!userId) {
    req.user = undefined;
    return next();
  }
  const user = repo.users.findById(userId);
  if (user) {
    req.user = { id: user.id, email: user.email, name: user.name };
  }
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}