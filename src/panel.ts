import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { FunctionNode } from './parser/extract';
import {
    explainFunction,
    ExplanationResult,
    generatePracticeBlocks,
    generateFileOverview,
    FileOverviewResult,
    callLLM,
    PracticeResult,
    PracticeBlock,
} from './apiClient';
import { validateBlock, ValidationResult } from './parser/validate';

// ── Internal state types ─────────────────────────────────

interface BlockState {
    completed: boolean;
    attempts: number;
    hintsUsed: number;
}

interface CachedPractice {
    fn: FunctionNode;
    data: PracticeResult;
    blockStates: Map<number, BlockState>;
    languageId: string;
}

// ── Panel ──────────────────────────────────────────────────

export class LearnPanel {
    public static currentPanel: LearnPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _functions: FunctionNode[] = [];
    private _activeIndex: number = 0;
    private _explanations: Map<string, ExplanationResult> = new Map();
    private _fileOverview: FileOverviewResult | null = null;
    private readonly _languageId: string;

    // practice state
    private _currentPractice: CachedPractice | null = null;
    private _isGeneratingPractice = false;

    private _currentRequest = 0;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionPath: string,
        functions: FunctionNode[],
        languageId: string
    ) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._functions = functions;
        this._languageId = languageId;

        this._panel.webview.html = this._getHtml();

        this._panel.webview.postMessage({
            type: 'init',
            functions: this._functions.map(f => ({ name: f.name, nodeType: f.nodeType })),
            activeIndex: 0,
        });

        this._panel.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            null,
            this._disposables
        );

        this._panel.onDidDispose(
            () => this.dispose(),
            null,
            this._disposables
        );
    }

    // ── Public factory ─────────────────────────────────────

    public static async create(
        extensionPath: string,
        functions: FunctionNode[],
        languageId: string
    ): Promise<LearnPanel> {
        const column = vscode.ViewColumn.Beside;

        if (LearnPanel.currentPanel) {
            LearnPanel.currentPanel._panel.reveal(column);
            await LearnPanel.currentPanel._update(functions);
            return LearnPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'learntovibe.learn',
            'LearnToVibe',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(extensionPath, 'media')),
                ],
            }
        );

        LearnPanel.currentPanel = new LearnPanel(panel, extensionPath, functions, languageId);
        return LearnPanel.currentPanel;
    }

    // ── Explain public API ─────────────────────────────────

    public selectFunction(index: number): void {
        this._activeIndex = index;
        this._loadFunction(index);
    }

    // ── Practice public API ─────────────────────────────────

    public async startPractice(fn: FunctionNode): Promise<void> {
        // If already have this exact practice cached and not stale, just switch
        if (this._currentPractice && this._currentPractice.fn === fn) {
            this._panel.webview.postMessage({ type: 'switchToPractice' });
            return;
        }

        this._panel.webview.postMessage({ type: 'generatingPractice' });

        try {
            const practiceData = await generatePracticeBlocks(fn);

            const blockStates = new Map<number, BlockState>();
            for (const block of practiceData.blocks) {
                blockStates.set(block.id, { completed: false, attempts: 0, hintsUsed: 0 });
            }

            this._currentPractice = {
                fn,
                data: practiceData,
                blockStates,
                languageId: this._languageId,
            };

            this._panel.webview.postMessage({
                type: 'initPractice',
                functionName: fn.name,
                blocks: practiceData.blocks,
            });
        } catch {
            this._panel.webview.postMessage({
                type: 'error',
                message: 'Failed to generate practice blocks.',
            });
        }
    }

    // ── Private handlers ───────────────────────────────────

    private async _loadFunction(index: number): Promise<void> {
        const requestId = ++this._currentRequest;
        const fn = this._functions[index];
        if (!fn) return;

        this._activeIndex = index;

        const cacheKey = `${fn.name}:${fn.startLine}:${fn.endLine}`;
        if (this._explanations.has(cacheKey)) {
            if (requestId !== this._currentRequest) return;

            this._panel.webview.postMessage({
                type: 'explanation',
                explanation: this._explanations.get(cacheKey),
            });
            return;
        }

        this._panel.webview.postMessage({
            type: 'loading',
            functionName: fn.name,
            activeIndex: index,
        });

        try {
            const result = await explainFunction(fn);

            if (requestId !== this._currentRequest) return;

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

    private async _loadFileOverview(): Promise<void> {
        try {
            const result = await generateFileOverview(this._functions);
            this._fileOverview = result;

            this._panel.webview.postMessage({
                type: 'fileOverview',
                overview: result,
            });
        } catch {
            this._fileOverview = {
                summary: 'Could not generate file overview.',
                responsibilities: [],
                patterns: [],
            };

            this._panel.webview.postMessage({
                type: 'fileOverview',
                overview: this._fileOverview,
            });
        }
    }

    private async _handleChat(messageText: string, mode: 'overview' | 'function'): Promise<void> {
        if (mode === 'overview') {
            const overview = this._fileOverview;
            const prompt = `
You are a programming tutor. The student is asking about the file overview.

File Summary: ${overview?.summary ?? 'Not available.'}
Responsibilities: ${(overview?.responsibilities ?? []).join(', ')}
Patterns: ${(overview?.patterns ?? []).join(', ')}

Student question: ${messageText}

Answer clearly and concisely in plain text, no JSON.
  `.trim();

            try {
                const reply = await callLLM(prompt, 512);
                this._panel.webview.postMessage({ type: 'chatReply', text: reply });
            } catch {
                this._panel.webview.postMessage({
                    type: 'chatReply',
                    text: 'Something went wrong. Try again.',
                });
            }
        } else {
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

Student question: ${messageText}

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
        }
    }

    private async _handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'loadOverview': {
                if (!this._fileOverview) {
                    await this._loadFileOverview();
                }
                break;
            }

            case 'selectFunction': {
                await this._loadFunction(message.index);
                break;
            }

            case 'chat': {
                await this._handleChat(message.text, message.mode);
                break;
            }

            case 'configure': {
                vscode.commands.executeCommand('learntovibe.setApiKey');
                break;
            }

            case 'done': {
                if (this._isGeneratingPractice) return;
                this._isGeneratingPractice = true;

                const fn = this._functions[this._activeIndex];
                if (!fn) {
                    this._isGeneratingPractice = false;
                    return;
                }

                this._panel.webview.postMessage({ type: 'generatingPractice' });

                try {
                    await this.startPractice(fn);
                    this._isGeneratingPractice = false;
                } catch {
                    this._isGeneratingPractice = false;
                    this._panel.webview.postMessage({
                        type: 'error',
                        message: 'Failed to generate practice blocks.',
                    });
                }
                break;
            }

            case 'check': {
                this._handlePracticeCheck(message.blockId, message.userInput);
                break;
            }

            case 'hint': {
                this._handlePracticeHint(message.blockId);
                break;
            }

            case 'complete': {
                if (this._currentPractice) {
                    const total = this._currentPractice.data.blocks.length;
                    const completed = [...this._currentPractice.blockStates.values()].filter(s => s.completed).length;
                    if (completed === total) {
                        vscode.window.showInformationMessage(
                            `You reconstructed ${this._currentPractice.fn.name} — ${total} blocks completed.`
                        );
                    }
                }
                break;
            }
        }
    }

    // ── Practice private handlers ──────────────────────────

    private _handlePracticeCheck(blockId: number, userInput: string): void {
        if (!this._currentPractice) return;

        const block = this._currentPractice.data.blocks.find(b => b.id === blockId);
        const state = this._currentPractice.blockStates.get(blockId);

        if (!block || !state) return;

        state.attempts += 1;

        const result = validateBlock(userInput, block.code, this._currentPractice.languageId);

        if (result.passed) {
            state.completed = true;
            this._currentPractice.blockStates.set(blockId, state);

            const next = this._getNextUncompletedBlock(blockId);

            this._panel.webview.postMessage({
                type: 'checkResult',
                blockId,
                correct: true,
                next,
            });
        } else {
            this._panel.webview.postMessage({
                type: 'checkResult',
                blockId,
                correct: false,
                attempts: state.attempts,
                reason: result.reason,
            });
        }
    }

    private _handlePracticeHint(blockId: number): void {
        if (!this._currentPractice) return;

        const block = this._currentPractice.data.blocks.find(b => b.id === blockId);
        const state = this._currentPractice.blockStates.get(blockId);

        if (!block || !state) return;

        state.hintsUsed += 1;
        this._currentPractice.blockStates.set(blockId, state);

        const hintText = state.hintsUsed === 1 ? block.hint1 : block.hint2;

        this._panel.webview.postMessage({
            type: 'hint',
            blockId,
            text: hintText,
            hintsUsed: state.hintsUsed,
            maxHints: 2,
        });
    }

    private _getNextUncompletedBlock(currentBlockId: number): number | null {
        if (!this._currentPractice) return null;

        for (const block of this._currentPractice.data.blocks) {
            if (block.id <= currentBlockId) continue;
            const state = this._currentPractice.blockStates.get(block.id);
            if (!state?.completed) return block.id;
        }

        return null;
    }

    // ── Panel lifecycle ─────────────────────────────────────

    private async _update(functions: FunctionNode[]): Promise<void> {
        this._functions = functions;
        this._activeIndex = 0;
        this._currentRequest = 0;

        this._panel.webview.postMessage({
            type: 'init',
            functions: this._functions.map(f => ({ name: f.name, nodeType: f.nodeType })),
            activeIndex: 0,
        });

        if (this._fileOverview) {
            this._panel.webview.postMessage({
                type: 'fileOverview',
                overview: this._fileOverview,
            });
        }
    }

    private _getHtml(): string {
        const htmlPath = path.join(this._extensionPath, 'media', 'panel.html');
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
        LearnPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}
