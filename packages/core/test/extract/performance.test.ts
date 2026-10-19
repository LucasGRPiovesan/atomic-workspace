import { expect, it } from 'vitest';
import { extractFile } from '../../src/extract/index.js';

it('reuses the parser for a 300-line module', async () => {
  const content = Array.from({ length: 100 }, (_, index) => `export function operation${index}(input: string) {\n  return input.trim();\n}`).join('\n');
  const files = new Set<string>();
  await extractFile('benchmark.ts', content, files);
  const start = performance.now();
  for (let index = 0; index < 20; index++) {
    const result = await extractFile('benchmark.ts', content, files);
    expect(result.symbols.filter(s => s.kind === 'function')).toHaveLength(100);
  }
  console.info(`Warm 300-line extraction mean: ${((performance.now() - start) / 20).toFixed(2)} ms`);
});
