export const symbols = { class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', method_declaration: 'method', constructor_declaration: 'method' } as const;
export const imports = ['import_declaration'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
