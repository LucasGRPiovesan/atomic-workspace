import type { Anchor, KnowledgeNode } from '../types.js';

/** Same estimator as ContextPack.estimatedTokens: ceil(chars / 4). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export const fmtLoc = (a: Pick<Anchor, 'path' | 'startLine' | 'endLine'>): string => {
  if (a.startLine === undefined) return a.path;
  return a.endLine !== undefined && a.endLine !== a.startLine ? `${a.path}:${a.startLine}-${a.endLine}` : `${a.path}:${a.startLine}`;
};

/** Status is only worth tokens when it is not the happy path. */
export const statusTag = (n: Pick<KnowledgeNode, 'status'>): string => (n.status === 'fresh' ? '' : ` (${n.status})`);

/** Cuts text to the token budget on a line boundary where possible. */
export function fitToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  const maxChars = Math.max(0, budgetTokens * 4 - 2);
  const cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  return (nl > maxChars * 0.5 ? cut.slice(0, nl) : cut.slice(0, Math.max(0, maxChars - 1))) + '…';
}
