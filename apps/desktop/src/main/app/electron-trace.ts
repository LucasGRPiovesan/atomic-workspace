import type { Session } from 'electron';
import type { Tracer } from './tracer';

/**
 * Feeds the tracer from the app webview's session. Listeners are non-blocking; timing is recorded per
 * request id. The session is the dedicated APP_PARTITION one, so replacing its webRequest listeners is safe.
 * Returns a detach function.
 */
export function attachTracer(ses: Session, tracer: Tracer, appOrigin: () => string | undefined): () => void {
  const started = new Map<number, number>();
  const inScope = (url: string): boolean => {
    const origin = appOrigin();
    if (!origin) return false;
    try { return new URL(url).origin === origin; } catch { return false; }
  };

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (inScope(details.url)) started.set(details.id, Date.now());
    callback({});
  });
  ses.webRequest.onCompleted((details) => {
    const startedAt = started.get(details.id);
    if (startedAt === undefined) return;
    started.delete(details.id);
    tracer.onRequest({
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      startedAt,
      durationMs: Date.now() - startedAt,
      resourceType: details.resourceType,
    });
  });
  ses.webRequest.onErrorOccurred((details) => { started.delete(details.id); });

  return () => {
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onCompleted(null);
    ses.webRequest.onErrorOccurred(null);
    started.clear();
  };
}
