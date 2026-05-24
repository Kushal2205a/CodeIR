import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FunctionNode } from './parser/extract';
import { PracticeResult, PracticeBlock } from './apiClient';
import * as crypto from 'crypto';

interface BlockState {
    completed: boolean;
    attempts: number;
    hintsUsed: number;
}

export class PracticePanel {
    public static currentPanel: PracticePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private readonly _fn: FunctionNode;
    private readonly _practiceData: PracticeResult;
    private _blockStates: Map<number, BlockState> = new Map();
    private _disposables: vscode.Disposable[] = [];

    public static async create(
        extensionPath: string,
        fn: FunctionNode,
        practiceData: PracticeResult
    ): Promise<PracticePanel> {
        const column = vscode.ViewColumn.Beside;

        if (PracticePanel.currentPanel) {
            PracticePanel.currentPanel._panel.reveal(column);
            PracticePanel.currentPanel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'learntovibe.practice',
            `LearnToVibe — Practice: ${fn.name}`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(extensionPath, 'media')),
                ],
            }
        );

        PracticePanel.currentPanel = new PracticePanel(
            panel,
            extensionPath,
            fn,
            practiceData
        );

        return PracticePanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionPath: string,
        fn: FunctionNode,
        practiceData: PracticeResult
    ) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._fn = fn;
        this._practiceData = practiceData;

        for (const block of practiceData.blocks) {
            this._blockStates.set(block.id, {
                completed: false,
                attempts: 0,
                hintsUsed: 0,
            });
        }

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

        // no setTimeout — wait for ready message from webview
    }

    private _sendInitialData(): void {
        this._panel.webview.postMessage({
            type: 'init',
            functionName: this._fn.name,
            blocks: this._practiceData.blocks,
        });
    }

    private async _handleMessage(message: any): Promise<void> {
        switch (message.type) {

            case 'ready':
                this._sendInitialData();
                break;

            case 'check': {
                const { blockId, userInput } = message;
                const block = this._practiceData.blocks.find(b => b.id === blockId);
                const state = this._blockStates.get(blockId);

                if (!block || !state) break;

                state.attempts += 1;

                const isCorrect = this._validateBlock(userInput, block);

                if (isCorrect) {
                    state.completed = true;
                    this._blockStates.set(blockId, state);

                    this._panel.webview.postMessage({
                        type: 'checkResult',
                        blockId,
                        correct: true,
                        next: this._getNextUncompletedBlock(blockId),
                    });
                } else {
                    this._panel.webview.postMessage({
                        type: 'checkResult',
                        blockId,
                        correct: false,
                        attempts: state.attempts,
                    });
                }
                break;
            }

            case 'hint': {
                const { blockId } = message;
                const block = this._practiceData.blocks.find(b => b.id === blockId);
                const state = this._blockStates.get(blockId);

                if (!block || !state) break;

                state.hintsUsed += 1;
                this._blockStates.set(blockId, state);

                const hintText = state.hintsUsed === 1 ? block.hint1 : block.hint2;

                this._panel.webview.postMessage({
                    type: 'hint',
                    blockId,
                    text: hintText,
                    hintsUsed: state.hintsUsed,
                    maxHints: 2,
                });
                break;
            }

            case 'complete': {
                const total = this._practiceData.blocks.length;
                const completed = [...this._blockStates.values()].filter(s => s.completed).length;

                if (completed === total) {
                    vscode.window.showInformationMessage(
                        `You reconstructed ${this._fn.name} — ${total} blocks completed.`
                    );
                }
                break;
            }
        }
    }

    private _validateBlock(userInput: string, block: PracticeBlock): boolean {
        const normalize = (s: string) =>
            s
                .replace(/\/\/.*$/gm, '')     // strip line comments
                .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
                .replace(/\s+/g, ' ')         // collapse whitespace
                .replace(/;\s*/g, ';')        // normalize semicolons
                .trim()
                .toLowerCase();

        return normalize(userInput) === normalize(block.code);
    }

    private _getNextUncompletedBlock(currentBlockId: number): number | null {
        const blocks = this._practiceData.blocks;

        for (const block of blocks) {
            if (block.id <= currentBlockId) continue;
            const state = this._blockStates.get(block.id);
            if (!state?.completed) return block.id;
        }

        return null;
    }

    private _getHtml(): string {
        const htmlPath = path.join(this._extensionPath, 'media', 'practice.html');
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
        PracticePanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}