export const symbols = {
  function_declaration: 'function', generator_function_declaration: 'function',
  class_declaration: 'class', abstract_class_declaration: 'class', method_definition: 'method',
  interface_declaration: 'interface', type_alias_declaration: 'type', enum_declaration: 'enum',
  variable_declarator: 'variable',
} as const;
export const imports = ['import_statement', 'call_expression', 'export_statement'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
