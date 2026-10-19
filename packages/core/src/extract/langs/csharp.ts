export const symbols = { class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', struct_declaration: 'type', record_declaration: 'type', method_declaration: 'method', constructor_declaration: 'method', local_function_statement: 'function' } as const;
export const imports = ['using_directive'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
