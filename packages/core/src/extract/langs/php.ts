export const symbols = { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'type', function_definition: 'function', method_declaration: 'method' } as const;
export const imports = ['namespace_use_declaration', 'include_expression', 'require_expression', 'include_once_expression', 'require_once_expression'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
