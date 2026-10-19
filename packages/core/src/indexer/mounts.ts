/** A router mounted by `X.use('/prefix', router)`; `ident` is resolved through the file's imports. */
export interface Mount {
  prefix: string;
  ident: string;
}

const USE_CALL = /\b[A-Za-z_$][\w$]*\.use\(\s*(?:(['"`])([^'"`\n]*)\1\s*,\s*)?([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+/g, '/').replace(/\/$/, '');
  return trimmed === '' || trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function joinPattern(prefix: string, pattern: string): string {
  const joined = `/${prefix}/${pattern}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

export function parseMounts(content: string): Mount[] {
  if (!content.includes('.use(')) return [];
  const mounts: Mount[] = [];
  for (const m of content.matchAll(USE_CALL)) {
    const prefix = normalizePrefix(m[2] ?? '');
    for (const arg of m[3].split(',')) {
      const ident = arg.trim();
      if (IDENT.test(ident)) mounts.push({ prefix, ident });
    }
  }
  return mounts;
}
