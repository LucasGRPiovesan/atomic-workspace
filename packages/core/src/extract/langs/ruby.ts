export const symbols = { class: 'class', module: 'type', method: 'method', singleton_method: 'method' } as const;
export const imports = ['call'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
