// Runs inside the Application webview (the developer's running app).
// Reports user interactions to the host page so they can be correlated with
// network requests and mapped to the software model. No data leaves the machine.
import { ipcRenderer } from 'electron';

function describe(el: Element | null): string {
  if (!el) return '';
  const target = el.closest('button, a, [role="button"], input, select, label, [data-testid]') ?? el;
  const text = (target.getAttribute('aria-label') || (target as HTMLElement).innerText || target.getAttribute('name') || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : '';
  return text ? `${tag}${id} “${text}”` : `${tag}${id}`;
}

window.addEventListener(
  'click',
  (e) => ipcRenderer.sendToHost('atomic-interaction', { kind: 'click', text: describe(e.target as Element), url: location.href }),
  true,
);

const notifyNav = () => ipcRenderer.sendToHost('atomic-interaction', { kind: 'navigation', url: location.href });
window.addEventListener('popstate', notifyNav);
for (const m of ['pushState', 'replaceState'] as const) {
  const orig = history[m].bind(history);
  history[m] = (...args: Parameters<History['pushState']>) => {
    orig(...args);
    notifyNav();
  };
}
