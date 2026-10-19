export const symbols = { function_item: 'function', struct_item: 'class', enum_item: 'enum', trait_item: 'interface', type_item: 'type', const_item: 'variable', static_item: 'variable' } as const;
export const imports = ['use_declaration', 'extern_crate_declaration'];
export const query = [...Object.keys(symbols), ...imports].map(type => `(${type}) @${type}`).join('\n');
