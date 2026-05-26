import Parser from 'tree-sitter';
import { languageMap, SupportedLanguage } from './languages';

export interface ValidationResult {
    passed: boolean;
    reason: string | null;
}

interface ASTFingerprint {
    nodeTypes: string[];
    operators: string[];
    methodCalls: string[];
    controlFlow: string[];
    hasReturn: boolean;
    hasAwait: boolean;
    hasThrow: boolean;
}

export function validateBlock(
    userInput: string,
    expectedCode: string,
    languageId: string
): ValidationResult {

    // Layer 1 — fast string normalization
    if (normalizeCode(userInput) === normalizeCode(expectedCode)) {
        return { passed: true, reason: null };
    }

    // Layer 2 — AST structural comparison
    const config = languageMap[languageId as SupportedLanguage];
    if (!config) {
        // fallback to string match if language not supported
        return {
            passed: false,
            reason: 'Could not parse your input for this language.',
        };
    }

    try {
        const parser = new Parser();
        parser.setLanguage(config.grammar as any);

        const userTree = parser.parse(wrapForParsing(userInput, languageId));
        const expectedTree = parser.parse(wrapForParsing(expectedCode, languageId));

        if (containsErrorNode(userTree.rootNode)) {
            return {
                passed: false,
                reason: 'Your code contains syntax errors.',
            };
        } 

        const userPrint = fingerprint(userTree.rootNode);
        const expectedPrint = fingerprint(expectedTree.rootNode);

      

        console.log('EXPECTED', expectedPrint);
        console.log('USER', userPrint);

        const expectedHasSignals =
            expectedPrint.methodCalls.length > 0 ||
            expectedPrint.operators.length > 0 ||
            expectedPrint.controlFlow.length > 0 ||
            expectedPrint.hasReturn ||
            expectedPrint.hasAwait ||
            expectedPrint.hasThrow;

        const userHasSignals =
            userPrint.methodCalls.length > 0 ||
            userPrint.operators.length > 0 ||
            userPrint.controlFlow.length > 0 ||
            userPrint.hasReturn ||
            userPrint.hasAwait ||
            userPrint.hasThrow;

        if (expectedHasSignals && !userHasSignals) {
            return {
                passed: false,
                reason: 'Your code is missing the expected logic structure.',
            };
        }

        return compareFingerprints(userPrint, expectedPrint);
    } catch {
        // if AST parse fails, fall back to string result
        return {
            passed: false,
            reason: 'Your code could not be parsed. Check for syntax errors.',
        };
    }
}

function wrapForParsing(code: string, languageId: string): string {
    switch (languageId) {
        case 'python':
            return `def __wrap__():\n  ${code.split('\n').join('\n  ')}`;
        case 'go':
            return `func __wrap__() {\n${code}\n}`;
        default:
            // typescript, typescriptreact, javascript, javascriptreact
            return `function __wrap__() {\n${code}\n}`;
    }
}

function fingerprint(node: any): ASTFingerprint {
    const result: ASTFingerprint = {
        nodeTypes: [],
        operators: [],
        methodCalls: [],
        controlFlow: [],
        hasReturn: false,
        hasAwait: false,
        hasThrow: false,
    };

    function walk(n: any) {
        const type = n.type as string;

        // control flow
        if (['if_statement', 'for_statement', 'while_statement',
            'switch_statement', 'try_statement', 'for_in_statement',
            'for_of_statement', 'enhanced_for_statement'].includes(type)) {
            result.controlFlow.push(type);
        }

        // operators
        if (type === 'binary_expression' || type === 'comparison_operator') {
            const op = n.children.find((c: any) =>
                ['>', '<', '>=', '<=', '===', '!==', '==', '!=',
                    '&&', '||', '+', '-', '*', '/'].includes(c.type)
            );
            if (op) result.operators.push(op.type);
        }

        // method calls
        if (type === 'call_expression' || type === 'method_invocation') {
            const fnNode = n.childForFieldName('function') ??
                n.childForFieldName('method');
            if (fnNode) result.methodCalls.push(fnNode.text);
        }

        // flags
        if (type === 'return_statement') result.hasReturn = true;
        if (type === 'await_expression') result.hasAwait = true;
        if (type === 'throw_statement') result.hasThrow = true;

        const NOISE_NODES = new Set([
            'program',
            'statement_block',
            'expression_statement',
            'identifier',
            'formal_parameters',
            'function_declaration',
            'function',
            'arguments',
            'parenthesized_expression',

            '(', ')', '{', '}', '[', ']',
            ',', ';', '.', ':',
        ]);

        if (!NOISE_NODES.has(type)) {
            result.nodeTypes.push(type);
        }

        for (const child of n.children) {
            walk(child);
        }
    }

    walk(node);
    return result;
}
function containsErrorNode(node: any): boolean {
    if (node.type === 'ERROR') return true;

    for (const child of node.children) {
        if (containsErrorNode(child)) return true;
    }

    return false;
}
function compareFingerprints(
    user: ASTFingerprint,
    expected: ASTFingerprint
): ValidationResult {

    // check return/await/throw flags
    if (expected.hasReturn && !user.hasReturn) {
        return { passed: false, reason: 'Your code is missing a return statement.' };
    }

    if (expected.hasAwait && !user.hasAwait) {
        return { passed: false, reason: 'Your code is missing an await expression.' };
    }

    if (expected.hasThrow && !user.hasThrow) {
        return { passed: false, reason: 'Your code is missing an error throw.' };
    }

    // check control flow matches
    const missingFlow = expected.controlFlow.filter(
        f => !user.controlFlow.includes(f)
    );
    if (missingFlow.length > 0) {
        const readable = missingFlow[0].replace(/_/g, ' ').replace(' statement', '');
        return {
            passed: false,
            reason: `Your code is missing a ${readable} block.`,
        };
    }

    // check operators match
    const expectedOps = [...new Set(expected.operators)].sort();
    const userOps = [...new Set(user.operators)].sort();
    if (JSON.stringify(expectedOps) !== JSON.stringify(userOps)) {
        return {
            passed: false,
            reason: 'The operators used differ from the expected logic.',
        };
    }

    // check method calls match
    const expectedCalls = [...new Set(expected.methodCalls)].sort();
    const userCalls = [...new Set(user.methodCalls)].sort();
    const missingCalls = expectedCalls.filter(c => !userCalls.includes(c));
    if (missingCalls.length > 0) {
        return {
            passed: false,
            reason: `Missing method call: ${missingCalls[0]}.`,
        };
    }

    // final check — node type similarity score
    // if the user input shares less than 60% of expected node types, fail
    const expectedSet = new Set(expected.nodeTypes);
    const intersection = user.nodeTypes.filter(t => expectedSet.has(t));
    const similarity = intersection.length / Math.max(expected.nodeTypes.length, 1);

    if (similarity < 0.8) {
        return {
            passed: false,
            reason: 'Your code structure does not match the expected logic.',
        };
    }

    return { passed: true, reason: null };
}

function normalizeCode(s: string): string {
    return s
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/;\s*/g, ';')
        .trim()
        .toLowerCase();
}