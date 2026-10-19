export const symbols = { function_definition: 'function', class_definition: 'class' } as const;
export const imports = ['import_statement', 'import_from_statement'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
