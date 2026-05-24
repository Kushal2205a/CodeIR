import * as vscode from 'vscode';
import { extractFunctions, FunctionNode } from './extract';
import { languageMap, SupportedLanguage } from './languages';

export function isSupported(languageId: string): boolean {
  return languageId in languageMap;
}

export function parseDocument(document: vscode.TextDocument): FunctionNode[] {
  const languageId = document.languageId;

  if (!isSupported(languageId)) {
    return [];
  }

  const sourceCode = document.getText();
  return extractFunctions(sourceCode, languageId as SupportedLanguage);
}

export function parseFunctionAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): FunctionNode | null {
  const functions = parseDocument(document);

  const cursorLine = position.line + 1;

  const match = functions.find(fn =>
    cursorLine >= fn.startLine && cursorLine <= fn.endLine
  );

  return match ?? null;
}

export { FunctionNode };