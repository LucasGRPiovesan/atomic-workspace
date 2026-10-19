import type { OpenStore } from '../contracts.js';
import { SqliteMemoryStore } from './store.js';

export { SqliteMemoryStore } from './store.js';

export const openStore: OpenStore = (root) => new SqliteMemoryStore(root);
