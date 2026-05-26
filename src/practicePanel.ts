import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FunctionNode } from './parser/extract';
import { PracticeResult, PracticeBlock } from './apiClient';
import * as crypto from 'crypto';
import { validateBlock, ValidationResult } from './parser/validate';
import { ExplainPanel } from './explainPanel';

interface BlockState {
    completed: boolean;
    attempts: number;
    hintsUsed: number;
}

export class PracticePanel {

    static currentPanel: PracticePanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;

    private _blocks: PracticeBlock[] = [];

    private _functionName = '';

    private _blockStates: Map<number, BlockState> = new Map();
    private _disposables: vscode.Disposable[] = [];

    private readonly _languageId: string;

    private _resetState() {

        this._blocks = [];

        this._blockStates.clear();
    }

    public static async create(
        extensionPath: string,
        fn: FunctionNode,
        practiceData: PracticeResult,
        languageId: string
    ): Promise<PracticePanel> {

    
        // Decide column based on whether Explain panel is open
        
        let column = vscode.ViewColumn.Beside;

        if (ExplainPanel.currentPanel) {
            // If Explain panel exists, open Practice as a new tab beside it
            column = vscode.ViewColumn.Beside;
        } else {
            // No Explain panel → open in new side panel (original behavior)
            column = vscode.ViewColumn.Beside;
        }

        
        // Reuse existing panel if possible
        
        if (PracticePanel.currentPanel) {
            PracticePanel.currentPanel._resetState();

            PracticePanel.currentPanel._blocks = practiceData.blocks;
            PracticePanel.currentPanel._functionName = fn.name;

            for (const block of practiceData.blocks) {
                PracticePanel.currentPanel._blockStates.set(block.id, {
                    completed: false,
                    attempts: 0,
                    hintsUsed: 0,
                });
            }

            PracticePanel.currentPanel._panel.title = `LearnToVibe — Practice: ${fn.name}`;
            PracticePanel.currentPanel._panel.reveal(column);

            setTimeout(() => {
                PracticePanel.currentPanel?._panel.webview.postMessage({
                    type: 'init',
                    functionName: fn.name,
                    blocks: practiceData.blocks,
                });
            }, 50);

            return PracticePanel.currentPanel;
        }

        
        // Create new panel
    
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
            practiceData,
            languageId
        );

        return PracticePanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionPath: string,
        fn: FunctionNode,
        practiceData: PracticeResult,
        languageId: string
    ) {

        this._panel = panel;

        this._extensionPath = extensionPath;

        this._languageId = languageId;

        this._functionName = fn.name;

        this._blocks = practiceData.blocks;

        for (const block of practiceData.blocks) {

            this._blockStates.set(
                block.id,
                {
                    completed: false,
                    attempts: 0,
                    hintsUsed: 0,
                }
            );
        }

        this._panel.webview.html = this._getHtml();

        setTimeout(() => {
            this._sendInitialData();
        }, 50);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {

                await this._handleMessage(message);
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(
            () => this.dispose(),
            null,
            this._disposables
        );
    }

    
    // Initial payload


    private _sendInitialData(): void {

        this._panel.webview.postMessage({
            type: 'init',

            functionName: this._functionName,

            blocks: this._blocks,
        });
    }

    
    // Message handling
    

    private async _handleMessage(
        message: any
    ): Promise<void> {

        switch (message.type) {



            case 'check': {

                const { blockId, userInput } = message;

                const block = this._blocks.find(
                    b => b.id === blockId
                );

                const state =
                    this._blockStates.get(blockId);

                if (!block || !state) {
                    break;
                }

                state.attempts += 1;

                const result =
                    this._validateBlock(
                        userInput,
                        block
                    );

                if (result.passed) {

                    state.completed = true;

                    this._blockStates.set(
                        blockId,
                        state
                    );

                    this._panel.webview.postMessage({
                        type: 'checkResult',

                        blockId,

                        correct: true,

                        next:
                            this._getNextUncompletedBlock(
                                blockId
                            ),
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

                break;
            }

            
            // Hint
            case 'hint': {

                const { blockId } = message;

                const block = this._blocks.find(
                    b => b.id === blockId
                );

                const state =
                    this._blockStates.get(blockId);

                if (!block || !state) {
                    break;
                }

                state.hintsUsed += 1;

                this._blockStates.set(
                    blockId,
                    state
                );

                const hintText =
                    state.hintsUsed === 1
                        ? block.hint1
                        : block.hint2;

                this._panel.webview.postMessage({
                    type: 'hint',

                    blockId,

                    text: hintText,

                    hintsUsed: state.hintsUsed,

                    maxHints: 2,
                });

                break;
            }

            
            // Completion
            case 'complete': {

                const total =
                    this._blocks.length;

                const completed =
                    [...this._blockStates.values()]
                        .filter(
                            s => s.completed
                        )
                        .length;

                if (completed === total) {

                    vscode.window.showInformationMessage(
                        `You reconstructed ${this._functionName} — ${total} blocks completed.`
                    );
                }

                break;
            }
        }
    }

    // Validation
    private _validateBlock(
        userInput: string,
        block: PracticeBlock
    ): ValidationResult {

        return validateBlock(
            userInput,
            block.code,
            this._languageId
        );
    }

    // Next block
    private _getNextUncompletedBlock(
        currentBlockId: number
    ): number | null {

        const blocks = this._blocks;

        for (const block of blocks) {

            if (block.id <= currentBlockId) {
                continue;
            }

            const state =
                this._blockStates.get(block.id);

            if (!state?.completed) {
                return block.id;
            }
        }

        return null;
    }

    // HTML
    private _getHtml(): string {

        const htmlPath = path.join(
            this._extensionPath,
            'media',
            'practice.html'
        );

        const cssUri =
            this._panel.webview.asWebviewUri(
                vscode.Uri.file(
                    path.join(
                        this._extensionPath,
                        'media',
                        'main.css'
                    )
                )
            );

        const nonce =
            crypto.randomUUID()
                .replace(/-/g, '');

        let html =
            fs.readFileSync(
                htmlPath,
                'utf8'
            );

        html = html.replace(
            /{{CSS_URI}}/g,
            cssUri.toString()
        );

        html = html.replace(
            /{{NONCE}}/g,
            nonce
        );

        return html;
    }


    // Dispose
    public dispose(): void {

        PracticePanel.currentPanel =
            undefined;

        this._panel.dispose();

        this._disposables.forEach(
            d => d.dispose()
        );

        this._disposables = [];
    }
}