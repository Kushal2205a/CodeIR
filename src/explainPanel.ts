import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FunctionNode } from './parser/extract';

import { explainFunction, ExplanationResult, generatePracticeBlocks, callLLM } from './apiClient';
import * as crypto from 'crypto';

export class ExplainPanel {
    public static currentPanel: ExplainPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _functions: FunctionNode[];
    private _activeIndex: number = 0;
    private _explanations: Map<string, ExplanationResult> = new Map();
    private _disposables: vscode.Disposable[] = [];
    private _currentRequest: number = 0;
    public static async create(
        extensionPath: string,
        functions: FunctionNode[]
    ): Promise<ExplainPanel> {
        const column = vscode.ViewColumn.Beside;

        if (ExplainPanel.currentPanel) {
            ExplainPanel.currentPanel._panel.reveal(column);
            await ExplainPanel.currentPanel._update(functions);
            return ExplainPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'learntovibe.explain',
            'LearnToVibe — Understand',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(extensionPath, 'media')),
                ],
            }
        );

        ExplainPanel.currentPanel = new ExplainPanel(panel, extensionPath, functions);
        return ExplainPanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionPath: string,
        functions: FunctionNode[]
    ) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._functions = functions;

        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            async (message) => await this._handleMessage(message),
            null,
            this._disposables
        );

        this._panel.onDidDispose(
            () => this.dispose(),
            null,
            this._disposables
        );

        // load first function automatically
        this._loadFunction(0);
    }

    private async _loadFunction(index: number): Promise<void> {

        const requestId = Date.now();
        this._currentRequest = requestId;
        const fn = this._functions[index];
        if (!fn) return;

        this._activeIndex = index;

        // send sidebar list immediately
        this._panel.webview.postMessage({
            type: 'init',
            functions: this._functions.map(f => ({
                name: f.name,
                nodeType: f.nodeType,
            })),
            activeIndex: index,
        });

        const cacheKey = `${fn.name}:${fn.startLine}:${fn.endLine}`;
        // check cache first
        if (this._explanations.has(cacheKey)) {
            this._panel.webview.postMessage({
                type: 'explanation',
                explanation: this._explanations.get(cacheKey),
            });
            return;
        }

        // show loading state
        this._panel.webview.postMessage({ type: 'loading', functionName: fn.name });

        if (requestId !== this._currentRequest) return;

        try {
            const result = await explainFunction(fn);
            this._explanations.set(cacheKey, result);

            this._panel.webview.postMessage({
                type: 'explanation',
                explanation: result,
            });
        } catch (err: any) {
            this._panel.webview.postMessage({
                type: 'error',
                message: err?.message ?? 'Unknown error occurred.',
            });
        }
    }

    private async _handleMessage(message: any): Promise<void> {
        switch (message.type) {

            case 'selectFunction':
                await this._loadFunction(message.index);
                break;

            case 'chat': {
                const fn = this._functions[this._activeIndex];
                const cached = this._explanations.get(
                    `${fn.name}:${fn.startLine}:${fn.endLine}`
                );

                const contextPrompt = `
You are a programming tutor. The student is asking about this function:

Function: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Explanation already given:
${cached?.explanation ?? 'none'}

Student question: ${message.text}

Answer clearly and concisely in plain text, no JSON.
  `.trim();

                try {
                    const reply = await callLLM(contextPrompt, 512);
                    this._panel.webview.postMessage({ type: 'chatReply', text: reply });
                } catch {
                    this._panel.webview.postMessage({
                        type: 'chatReply',
                        text: 'Something went wrong. Try again.',
                    });
                }
                break;
            }

            case 'done': {
                const fn = this._functions[this._activeIndex];

                this._panel.webview.postMessage({ type: 'generatingPractice' });

                try {
                    const practiceData = await generatePracticeBlocks(fn);
                    const { PracticePanel } = await import('./practicePanel.ts');
                    await PracticePanel.create(this._extensionPath, fn, practiceData);

                    // clear the loading state
                    this._panel.webview.postMessage({ type: 'doneComplete' });
                } catch {
                    this._panel.webview.postMessage({
                        type: 'error',
                        message: 'Failed to generate practice blocks.',
                    });
                }
                break;
            }
        }
    }

    private async _update(functions: FunctionNode[]): Promise<void> {
        this._functions = functions;
        this._activeIndex = 0;
        this._explanations.clear();
        await this._loadFunction(0);
    }

    private _getHtml(): string {
        const htmlPath = path.join(this._extensionPath, 'media', 'explain.html');
        const cssUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._extensionPath, 'media', 'main.css'))
        );

        const nonce = crypto.randomUUID().replace(/-/g, '');

        let html = fs.readFileSync(htmlPath, 'utf8');
        html = html.replace(/{{CSS_URI}}/g, cssUri.toString());
        html = html.replace(/{{NONCE}}/g, nonce);
        return html;
    }
    public dispose(): void {
        ExplainPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}