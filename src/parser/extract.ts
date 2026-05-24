import Parser from 'tree-sitter';
import { languageMap, SupportedLanguage } from './languages';

type SyntaxNode = Parser.SyntaxNode;

export interface FunctionNode {
  name:      string;
  params:    string[];
  body:      string;
  signature: string;
  startLine: number;
  endLine:   number;
  nodeType:  'function' | 'method';
  rawSource: string;
}

export function extractFunctions(
  sourceCode: string,
  languageId: string
): FunctionNode[] {
  const config = languageMap[languageId as SupportedLanguage];
  if (!config) return [];

  const parser = new Parser();
  parser.setLanguage(config.grammar as any);

  const tree = parser.parse(sourceCode);

  const allTargetTypes = [...config.functionNodes, ...config.methodNodes];
  const nodes = tree.rootNode.descendantsOfType(allTargetTypes);

  const results: FunctionNode[] = [];

  for (const node of nodes) {
    const extracted = extractFromNode(node, sourceCode, config.methodNodes.includes(node.type) ? 'method' : 'function');
    if (extracted) results.push(extracted);
  }

  return results;
}

function resolveArrowFunctionName(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;

  // const hello = () => {}
  if (parent.type === 'variable_declarator') {
    const nameNode = parent.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }

  // export const hello = () => {}
  if (parent.type === 'lexical_declaration' || parent.type === 'variable_declaration') {
    const declarator = parent.children.find((c: SyntaxNode) => c.type === 'variable_declarator');
    if (declarator) {
      const nameNode = declarator.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
  }

  return null;
}

function extractFromNode(
  node: SyntaxNode,
  sourceCode: string,
  nodeType: 'function' | 'method'
): FunctionNode | null {
  let name: string | null = null;

  const isArrow = node.type === 'arrow_function' || node.type === 'function_expression';

  if (isArrow) {
    name = resolveArrowFunctionName(node);
  } else {
    const nameNode = node.childForFieldName('name');
    name = nameNode ? nameNode.text : null;
  }

  if (!name) return null;

  const paramNode = node.children.find((c: SyntaxNode) =>
    c.type === 'formal_parameters' ||
    c.type === 'parameters'        ||
    c.type === 'parameter_list'
  );

  // flatten all params to text, handles simple + complex cases
  const params = paramNode
    ? paramNode.children
        .filter((c: SyntaxNode) => c.type !== ',' && c.type !== '(' && c.type !== ')')
        .map((c: SyntaxNode) => c.text)
    : [];

  const startLine  = node.startPosition.row + 1;
  const endLine    = node.endPosition.row + 1;
  const rawSource  = sourceCode.slice(node.startIndex, node.endIndex);

  // separate signature from body for clarity
  const bodyNode   = node.childForFieldName('body');
  const body       = bodyNode ? sourceCode.slice(bodyNode.startIndex, bodyNode.endIndex) : rawSource;
  const signature  = rawSource.slice(0, bodyNode ? bodyNode.startIndex - node.startIndex : rawSource.length);

  return { name, params, body, signature, startLine, endLine, nodeType, rawSource };
}