import express from 'express';
import { apiRouter } from './api/index.ts';
import { authMiddleware } from './auth/middleware.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ?? 4310;

app.use(express.json());
app.use(authMiddleware);
app.use('/api', apiRouter);

app.use(express.static(path.join(__dirname, '../public')));

app.get('/{*any}', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Shop listening on http://localhost:${PORT}`);
});