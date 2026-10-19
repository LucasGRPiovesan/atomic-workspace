export const symbols = { function_declaration: 'function', method_declaration: 'method', type_spec: 'type' } as const;
export const imports = ['import_spec'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
