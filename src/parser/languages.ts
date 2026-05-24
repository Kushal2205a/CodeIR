export interface LanguageConfig {
  grammar: unknown
  functionNodes: string[]
  methodNodes: string[]
  parameterNode: string
  nameNode: string
}

export const languageMap: Record<string, LanguageConfig> = {
  typescript: {
    grammar: require('tree-sitter-typescript').typescript,
    functionNodes: ['function_declaration', 'function_expression', 'arrow_function'],
    methodNodes:   ['method_definition', 'public_method_definition'],
    parameterNode: 'formal_parameters',
    nameNode:      'identifier',
  },
  javascript: {
    grammar: require('tree-sitter-javascript'),
    functionNodes: ['function_declaration', 'function_expression', 'arrow_function'],
    methodNodes:   ['method_definition'],
    parameterNode: 'formal_parameters',
    nameNode:      'identifier',
  },
  typescriptreact: {
    grammar:       require('tree-sitter-typescript').tsx,
    functionNodes: ['function_declaration', 'function_expression', 'arrow_function'],
    methodNodes:   ['method_definition', 'public_method_definition'],
    parameterNode: 'formal_parameters',
    nameNode:      'identifier',
    },
    javascriptreact: {
    grammar:       require('tree-sitter-javascript'),
    functionNodes: ['function_declaration', 'function_expression', 'arrow_function'],
    methodNodes:   ['method_definition'],
    parameterNode: 'formal_parameters',
    nameNode:      'identifier',
    },
  python: {
    grammar: require('tree-sitter-python'),
    functionNodes: ['function_definition'],
    methodNodes:   ['function_definition'],
    parameterNode: 'parameters',
    nameNode:      'identifier',
  },
  go: {
    grammar: require('tree-sitter-go'),
    functionNodes: ['function_declaration'],
    methodNodes:   ['method_declaration'],
    parameterNode: 'parameter_list',
    nameNode:      'identifier',
  },
}

export type SupportedLanguage = keyof typeof languageMap