import * as vscode from 'vscode';
import { parseDocument, parseFunctionAtCursor, isSupported } from './parser/index';
import { LearnPanel } from './panel';
import { generatePracticeBlocks, initSecretStorage, setApiKey, clearApiKey } from './apiClient';

export function activate(context: vscode.ExtensionContext): void {
	const extensionPath = context.extensionPath;

	// Initialize SecretStorage for API keys
	initSecretStorage(context.secrets);

	// set supported languages as context for when clauses in package.json
	vscode.commands.executeCommand(
		'setContext',
		'learntovibe.supportedLanguages',
		['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'go']
	);

	// command: learn function at cursor
	const learnCommand = vscode.commands.registerCommand(
		'learntovibe.learnFunction',
		async (functionName?: string) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			if (!isSupported(editor.document.languageId)) {
				vscode.window.showWarningMessage('LearnToVibe: this file type is not supported.');
				return;
			}

			const functions = parseDocument(editor.document);
			if (functions.length === 0) {
				vscode.window.showWarningMessage('LearnToVibe: no functions found in this file.');
				return;
			}

			// If called from a codelens, functionName is passed directly.
			// If called from the command palette or keybinding, fall back to cursor position.
			let targetFn = functionName
				? functions.find(f => f.name === functionName)
				: parseFunctionAtCursor(editor.document, editor.selection.active);

			// If no function at cursor, default to first
			if (!targetFn) {
				targetFn = functions[0];
			}

			const targetIndex = functions.findIndex(f => f.name === targetFn!.name);

			const panel = await LearnPanel.create(
				extensionPath,
				functions,
				editor.document.languageId
			);

			// Immediately switch to the target function
			if (targetIndex !== -1) {
				panel.selectFunction(targetIndex);
			}
		}
	);

	// command: practice function at cursor directly
	const practiceCommand = vscode.commands.registerCommand(
		'learntovibe.practiceFunction',
		async (functionName?: string) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			if (!isSupported(editor.document.languageId)) {
				vscode.window.showWarningMessage(
					'LearnToVibe: this file type is not supported.'
				);
				return;
			}

			const functions = parseDocument(editor.document);

			// If called from a codelens, functionName is passed directly.
			// Otherwise fall back to cursor position.
			const fn = functionName
				? functions.find(f => f.name === functionName) ?? parseFunctionAtCursor(editor.document, editor.selection.active)
				: parseFunctionAtCursor(editor.document, editor.selection.active);

			if (!fn) {
				vscode.window.showWarningMessage(
					'LearnToVibe: place your cursor inside a function first.'
				);
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `LearnToVibe: generating practice for ${fn.name}...`,
					cancellable: false,
				},
				async () => {
					const panel = await LearnPanel.create(
						extensionPath,
						functions,
						editor.document.languageId
					);
					await panel.startPractice(fn);
				}
			);
		}
	);

	// codelens provider
	const codeLensProvider = vscode.languages.registerCodeLensProvider(
		[
			{ language: 'typescript' },
			{ language: 'typescriptreact' },
			{ language: 'javascript' },
			{ language: 'javascriptreact' },
			{ language: 'python' },
			{ language: 'go' },
		],
		new LearnToVibeCodeLensProvider()
	);


	const settingsWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('learntovibe')) {
			// dispose and recreate current panel so it picks up new settings
			if (LearnPanel.currentPanel) {
				vscode.window.showInformationMessage(
					'LearnToVibe: settings updated. Reloading...'
				);
				LearnPanel.currentPanel.dispose();
			}
		}
	});

	// command: set API key (stores in SecretStorage)
	const setApiKeyCommand = vscode.commands.registerCommand(
		'learntovibe.setApiKey',
		async () => {
			type Provider = { label: string; id: 'nvidia' | 'openai' | 'anthropic'; url: string };
			const providers: Provider[] = [
				{ label: 'NVIDIA', id: 'nvidia', url: 'https://build.nvidia.com' },
				{ label: 'OpenAI', id: 'openai', url: 'https://platform.openai.com' },
				{ label: 'Anthropic', id: 'anthropic', url: 'https://console.anthropic.com' },
			];

			const selected = await vscode.window.showQuickPick(providers, {
				placeHolder: 'Select provider to set API key',
			});
			if (!selected) return;

			const key = await vscode.window.showInputBox({
				prompt: `Enter your ${selected.label} API key:`,
				title: `${selected.label} API Key`,
				ignoreFocusOut: true,
				password: true,
			});
			if (!key) return;

			await setApiKey(selected.id, key);
			vscode.window.showInformationMessage(`${selected.label} API key saved securely.`);
		}
	);

	// command: clear API key
	const clearApiKeyCommand = vscode.commands.registerCommand(
		'learntovibe.clearApiKey',
		async () => {
			type Provider = { label: string; id: 'nvidia' | 'openai' | 'anthropic' };
			const providers: Provider[] = [
				{ label: 'NVIDIA', id: 'nvidia' },
				{ label: 'OpenAI', id: 'openai' },
				{ label: 'Anthropic', id: 'anthropic' },
			];

			const selected = await vscode.window.showQuickPick(providers, {
				placeHolder: 'Select provider to clear API key',
			});
			if (!selected) return;

			await clearApiKey(selected.id);
			vscode.window.showInformationMessage(`${selected.label} API key cleared.`);
		}
	);

	context.subscriptions.push(
		learnCommand,
		practiceCommand,
		codeLensProvider,
		settingsWatcher,
		setApiKeyCommand,
		clearApiKeyCommand
	);
}



export function deactivate(): void {
	LearnPanel.currentPanel?.dispose();
}

class LearnToVibeCodeLensProvider implements vscode.CodeLensProvider {
	public provideCodeLenses(
		document: vscode.TextDocument
	): vscode.CodeLens[] {
		if (!isSupported(document.languageId)) return [];

		const functions = parseDocument(document);
		const lenses: vscode.CodeLens[] = [];


		for (const fn of functions) {
			const line = fn.startLine - 1;
			const range = new vscode.Range(line, 0, line, 0);

			lenses.push(
				new vscode.CodeLens(range, {
					title: '$(book) Learn',
					command: 'learntovibe.learnFunction',
					arguments: [fn.name],
					tooltip: `Open explanation for ${fn.name}`,
				})
			);

			lenses.push(
				new vscode.CodeLens(range, {
					title: '$(pencil) Practice',
					command: 'learntovibe.practiceFunction',
					arguments: [fn.name],
					tooltip: `Jump straight to practice for ${fn.name}`,
				})
			);
		}

		return lenses;
	}
}
