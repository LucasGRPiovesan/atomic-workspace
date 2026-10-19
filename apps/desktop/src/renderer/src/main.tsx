import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';

async function boot() {
  if (!window.atomic) await import('./mock').then((m) => m.installMock());
  createRoot(document.getElementById('root')!).render(<App />);
}
void boot();
