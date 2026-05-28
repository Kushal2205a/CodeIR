import axios from 'axios';
import * as vscode from 'vscode';
import { FunctionNode } from './parser/extract';

const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_PRIMARY_TIMEOUT_MS = 75000;
const NVIDIA_FALLBACK_TIMEOUT_MS = 75000;
const NVIDIA_FALLBACK_MODEL = 'nvidia/llama-3.1-nemotron-nano-8b-v1';

export interface ExplanationResult {
    functionName: string;
    explanation: string;
    concepts: string[];
    callInfo: string;
}

export interface PracticeBlock {
    id: number;
    instruction: string;
    code: string;
    hint1: string;
    hint2: string;
    type:
    | 'signature'
    | 'expression'
    | 'control-flow'
    | 'return'
    | 'async'
    | 'declaration';
}

export interface PracticeResult {
    functionName: string;
    blocks: PracticeBlock[];
}

export interface FileOverviewResult {
    summary: string;
    responsibilities: string[];
    patterns: string[];
}

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('learntovibe');
    return {
        provider: cfg.get<string>('apiProvider') ?? 'nvidia',
        nvidiaModel: cfg.get<string>('nvidia.model') ?? NVIDIA_FALLBACK_MODEL,
        openaiModel: cfg.get<string>('openai.model') ?? 'gpt-4o',
        anthropicModel: cfg.get<string>('anthropic.model') ?? 'claude-sonnet-4-20250514',
        ollamaBaseUrl: cfg.get<string>('ollama.baseUrl') ?? 'http://localhost:11434',
        ollamaModel: cfg.get<string>('ollama.model') ?? 'llama3.1',
    };
}

// ── SecretStorage helpers ─────────────────────────────────

let _secretStorage: vscode.SecretStorage | undefined;
let _nvidiaOutput: vscode.OutputChannel | undefined;

export function initSecretStorage(secrets: vscode.SecretStorage) {
    _secretStorage = secrets;
}

export function initNvidiaDiagnosticsOutput(output: vscode.OutputChannel) {
    _nvidiaOutput = output;
}

async function getApiKey(provider: 'nvidia' | 'openai' | 'anthropic'): Promise<string | undefined> {
    // 1. Try SecretStorage first (secure)
    if (_secretStorage) {
        const key = await _secretStorage.get(`${provider}-apiKey`);
        if (key) return key;
    }
    // 2. Fall back to old settings for backward compatibility
    const cfg = vscode.workspace.getConfiguration('learntovibe');
    const oldKey = cfg.get<string>(`${provider}.apiKey`)
        ?? (provider === 'nvidia' ? cfg.get<string>('nvidiaApiKey') : undefined);
    if (oldKey) return oldKey;
    return undefined;
}

export async function setApiKey(provider: 'nvidia' | 'openai' | 'anthropic', key: string): Promise<void> {
    if (!_secretStorage) throw new Error('SecretStorage not initialized');
    await _secretStorage.store(`${provider}-apiKey`, key);
}

export async function clearApiKey(provider: 'nvidia' | 'openai' | 'anthropic'): Promise<void> {
    if (!_secretStorage) throw new Error('SecretStorage not initialized');
    await _secretStorage.delete(`${provider}-apiKey`);
}

function previewJson(value: unknown, maxLength: number = 1200): string {
    const text = typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function logAxiosError(output: vscode.OutputChannel, err: unknown): void {
    if (!axios.isAxiosError(err)) {
        output.appendLine(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    output.appendLine(`Axios error message: ${err.message}`);
    output.appendLine(`Axios error code: ${err.code ?? 'none'}`);

    if (err.response) {
        output.appendLine(`HTTP status: ${err.response.status}`);
        output.appendLine(`Response headers: ${previewJson(err.response.headers, 1600)}`);
        output.appendLine(`Response body preview: ${previewJson(err.response.data, 2000)}`);
        return;
    }

    if (err.request) {
        output.appendLine('Request was sent, but no response was received before failure.');
        return;
    }

    output.appendLine('Request failed before it was sent.');
}

function logNvidia(message: string): void {
    _nvidiaOutput?.appendLine(message);
}

export async function diagnoseNvidia(output: vscode.OutputChannel): Promise<boolean> {
    const { provider, nvidiaModel } = getConfig();
    const nvidiaApiKey = await getApiKey('nvidia');
    const prompt = 'Reply with {"ok":true} only.';
    const timeoutMs = 200000;
    const payload = {
        model: nvidiaModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
        chat_template_kwargs: { thinking: false },
    };

    output.clear();
    output.show(true);
    output.appendLine('LearnToVibe NVIDIA Diagnostic');
    output.appendLine(`Started: ${new Date().toISOString()}`);
    output.appendLine(`Resolved provider: ${provider}`);
    output.appendLine(`Resolved NVIDIA model: ${nvidiaModel}`);
    output.appendLine(`NVIDIA key found: ${nvidiaApiKey ? 'yes' : 'no'}`);
    output.appendLine(`Prompt length: ${prompt.length}`);
    output.appendLine(`Max tokens: ${payload.max_tokens}`);
    output.appendLine(`Timeout ms: ${timeoutMs}`);
    output.appendLine(`Payload summary: ${previewJson({
        ...payload,
        messages: [{ role: 'user', contentLength: prompt.length }],
    })}`);

    if (!nvidiaApiKey) {
        output.appendLine('Result: failed before request. NVIDIA API key was not found.');
        return false;
    }

    const startedAt = Date.now();
    output.appendLine(`Request start: ${new Date(startedAt).toISOString()}`);

    try {
        const response = await axios.post(
            NVIDIA_CHAT_URL,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${nvidiaApiKey}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                timeout: timeoutMs,
                validateStatus: status => status >= 200 && status < 300,
            }
        );

        const elapsedMs = Date.now() - startedAt;
        output.appendLine(`Elapsed ms: ${elapsedMs}`);
        output.appendLine(`HTTP status: ${response.status}`);
        output.appendLine(`Response body preview: ${previewJson(response.data, 2000)}`);
        output.appendLine('Result: success. The tiny NVIDIA diagnostic request completed.');
        return true;
    } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        output.appendLine(`Elapsed ms: ${elapsedMs}`);
        logAxiosError(output, err);
        output.appendLine('Result: failed. Use the status/error details above to identify the failing layer.');
        return false;
    }
}

function shouldTryNvidiaFallback(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    const status = err.response?.status;
    return err.code === 'ECONNABORTED' || status === 404 || status === 429 || (status !== undefined && status >= 500);
}

async function postNvidiaChat(
    model: string,
    prompt: string,
    maxTokens: number,
    apiKey: string,
    timeoutMs: number,
    signal?: AbortSignal
) {
    return axios.post(
        NVIDIA_CHAT_URL,
        {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
            top_p: 1.0,
            stream: false,
            chat_template_kwargs: { thinking: false },
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            signal,
            timeout: timeoutMs,
            validateStatus: status => status >= 200 && status < 300,
        }
    );
}

async function callNvidia(prompt: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    const { nvidiaModel } = getConfig();
    const nvidiaApiKey = await getApiKey('nvidia');

    if (!nvidiaApiKey) {
        throw new Error('NVIDIA API key not set. Run "LearnToVibe: Set API Key" to configure it.');
    }

    const startedAt = Date.now();
    logNvidia('');
    logNvidia('NVIDIA normal request');
    logNvidia(`Started: ${new Date(startedAt).toISOString()}`);
    logNvidia(`Model: ${nvidiaModel}`);
    logNvidia(`Prompt length: ${prompt.length}`);
    logNvidia(`Max tokens: ${maxTokens}`);
    logNvidia(`Primary timeout ms: ${NVIDIA_PRIMARY_TIMEOUT_MS}`);

    try {
        let modelUsed = nvidiaModel;
        let response;

        try {
            response = await postNvidiaChat(
                nvidiaModel,
                prompt,
                maxTokens,
                nvidiaApiKey,
                NVIDIA_PRIMARY_TIMEOUT_MS,
                signal
            );
        } catch (err) {
            if (nvidiaModel === NVIDIA_FALLBACK_MODEL || !shouldTryNvidiaFallback(err)) {
                throw err;
            }

            logNvidia(`Primary model failed after ${Date.now() - startedAt} ms.`);
            if (_nvidiaOutput) {
                logAxiosError(_nvidiaOutput, err);
            }
            logNvidia(`Retrying with fallback model: ${NVIDIA_FALLBACK_MODEL}`);
            logNvidia(`Fallback timeout ms: ${NVIDIA_FALLBACK_TIMEOUT_MS}`);

            modelUsed = NVIDIA_FALLBACK_MODEL;
            response = await postNvidiaChat(
                NVIDIA_FALLBACK_MODEL,
                prompt,
                maxTokens,
                nvidiaApiKey,
                NVIDIA_FALLBACK_TIMEOUT_MS,
                signal
            );
        }

        const elapsedMs = Date.now() - startedAt;
        logNvidia(`Elapsed ms: ${elapsedMs}`);
        logNvidia(`Model used: ${modelUsed}`);
        logNvidia(`HTTP status: ${response.status}`);

        const raw = response.data.choices?.[0]?.message?.content ?? '';
        if (!raw) {
            throw new Error(`NVIDIA returned an empty response for model ${modelUsed}.`);
        }
        logNvidia(`Response chars: ${raw.length}`);
        return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err: any) {
        const elapsedMs = Date.now() - startedAt;
        logNvidia(`Elapsed ms: ${elapsedMs}`);
        if (_nvidiaOutput) {
            logAxiosError(_nvidiaOutput, err);
        }
        throw new Error(formatNvidiaError(err, nvidiaModel));
    }
}

function formatNvidiaError(err: any, model: string): string {
    if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
        return 'NVIDIA request was cancelled.';
    }

    if (err?.code === 'ECONNABORTED') {
        return `NVIDIA request timed out for model ${model}. The payload now uses bounded tokens with thinking disabled; if this persists, try a faster NVIDIA model or check provider availability.`;
    }

    const status = err?.response?.status;
    const data = err?.response?.data;
    const detail = typeof data === 'string'
        ? data
        : data?.detail ?? data?.message ?? data?.error?.message ?? JSON.stringify(data ?? {});

    if (status === 404) {
        return `NVIDIA returned 404 for model ${model}. The endpoint is correct, so this usually means the model is not enabled for your NVIDIA account/API key or the configured model ID is unavailable. Try a model listed in your NVIDIA account's /v1/models response. Details: ${detail}`;
    }

    if (status) {
        return `NVIDIA request failed with HTTP ${status} for model ${model}: ${detail}`;
    }

    return `NVIDIA request failed for model ${model}: ${err?.message ?? 'unknown error'}`;
}

async function callOpenAI(prompt: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    const { openaiModel } = getConfig();
    const openaiApiKey = await getApiKey('openai');

    if (!openaiApiKey) {
        throw new Error('OpenAI API key not set. Run "LearnToVibe: Set API Key" to configure it.');
    }

    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: openaiModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
        },
        {
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json',
            },
            signal,
            timeout: 180000,
        }
    );

    return response.data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(prompt: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    const { anthropicModel } = getConfig();
    const anthropicApiKey = await getApiKey('anthropic');

    if (!anthropicApiKey) {
        throw new Error('Anthropic API key not set. Run "LearnToVibe: Set API Key" to configure it.');
    }

    const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model: anthropicModel,
            max_tokens: maxTokens,
            temperature: 0.7,
            messages: [{ role: 'user', content: prompt }],
        },
        {
            headers: {
                'x-api-key': anthropicApiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            signal,
            timeout: 180000,
        }
    );

    return response.data.content?.[0]?.text ?? '';
}

async function callOllama(prompt: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    const { ollamaBaseUrl, ollamaModel } = getConfig();

    const payload = JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: {
            num_predict: maxTokens,
            temperature: 0.7,
        },
    });


    console.log(`[Ollama] Using model: ${ollamaModel}`);

    try {
        const response = await axios({
            method: 'post',
            url: `${ollamaBaseUrl}/api/chat`,
            data: payload,
            headers: { 'Content-Type': 'application/json' },
            signal,
            timeout: 180000,        // ← Increased to 3 minutes
        });

        // ── NEW: Better response logging ─────────────────────
        const content = response.data.message?.content ?? '';
        console.log(`[Ollama] Raw response length: ${content.length} chars`);
        return content;
    } catch (err: any) {
        // ── NEW: Much better error diagnostics ───────────────
        console.error('[Ollama] ERROR:', err.message);

        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Response Data:', JSON.stringify(err.response.data, null, 2));
        } else if (err.request) {
            console.error('No response received from Ollama. Is it running?');
        }
        throw new Error(`Ollama failed with model ${ollamaModel}: ${err.message}`);
    }
}

export async function callLLM(prompt: string, maxTokens: number = 2048, signal?: AbortSignal): Promise<string> {
    const { provider } = getConfig();
    switch (provider) {
        case 'nvidia': return callNvidia(prompt, maxTokens, signal);
        case 'openai': return callOpenAI(prompt, maxTokens, signal);
        case 'anthropic': return callAnthropic(prompt, maxTokens, signal);
        case 'ollama': return callOllama(prompt, maxTokens, signal);
        default: throw new Error(`Unknown provider: ${provider}`);
    }
}

export async function generateFileOverview(
    functions: FunctionNode[],
    signal?: AbortSignal
): Promise<FileOverviewResult> {

    const functionContext = functions
        .map(fn => {

            const preview =
                fn.body
                    .split('\n')
                    .slice(0, 8)
                    .join('\n');

            return `
Function: ${fn.name}
Signature: ${fn.signature}
Preview:
${preview}
`;
        })
        .join('\n\n');

    const prompt = `You are an expert programming tutor.

A student is trying to understand a source code file containing these functions:

${functionContext}

Analyze the file and respond with **valid JSON only** (no markdown, no extra text):

{
  "summary": "A concise 2-3 sentence summary of what this file does overall",
  "responsibilities": [
    "Main responsibility 1",
    "Main responsibility 2"
  ],
  "patterns": [
    "React hooks pattern",
    "Form handling",
    "Async data mutation"
  ]
}

Infer the file's purpose from function names and code structure.`;

    const raw = await callLLM(prompt, 512, signal);
    return parseFileOverview(raw);
}
export async function explainFunction(fn: FunctionNode, signal?: AbortSignal): Promise<ExplanationResult> {
    const raw = await callLLM(buildExplanationPrompt(fn), 512, signal);
    return parseExplanationResponse(raw, fn.name);
}

export async function generatePracticeBlocks(fn: FunctionNode, signal?: AbortSignal): Promise<PracticeResult> {
    console.log('Generating practice blocks...');
    const raw = await callLLM(buildPracticePrompt(fn), 1536, signal);
    console.log('RAW RESPONSE:', raw);
    return parsePracticeResponse(raw, fn.name);
}

function buildExplanationPrompt(fn: FunctionNode): string {
    return `You are a programming tutor. Explain the following function for a student who is learning to code. Be concise — use 3-5 sentences max.

Function name: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Your task:
1. Write a concise plain-English explanation of what this function does and why it's useful.
2. List 1-2 key programming concepts demonstrated.

Output ONLY a raw JSON object — no markdown, no code fences, no extra text before or after.
The JSON must use exactly these keys:

{
  "explanation": "<your explanation here>",
  "concepts": ["<concept A>"],
  "callInfo": ""
}`;
}

function buildPracticePrompt(fn: FunctionNode): string {
    return `You are an expert programming tutor. Break this function into logical learning blocks for a student to reconstruct it step by step.

Function name: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Rules:
- Only create blocks for logic INSIDE the function body.
- Do NOT create blocks for imports, top-level declarations, interfaces, types, helper functions, or external context.
- Focus on meaningful reasoning steps: conditions, validations, loops, transformations, async logic, and returns.
- Each block must represent one logical step in the function's flow.

Block sizing guidelines:
- Avoid overly tiny blocks containing only a single operator or keyword.
- Avoid overly large blocks that combine multiple reasoning steps.
- Most functions should be broken into 3–6 logical reconstruction steps depending on complexity.
- A block should usually represent one conceptual action in the function flow.
-Blocks must follow the exact execution flow of the function from top to bottom.

Key Guidelines for Instructions:
- Make instructions pedagogical and rich — explain WHY the step exists, what programming concept is being used, and how it contributes to the overall function.
- Avoid robotic, shallow instructions like "Check if value is string".
- Prefer teaching-oriented instructions like:
  - "Use an if statement to guard against non-string values before calling string methods."
  - "Retrieve the submitted value from formData using the provided key to prepare for validation."
  - "Clean the string by removing leading and trailing whitespace to ensure consistent data."

Progressive Difficulty:
- Early blocks should be more guided (clearer what to do).
- Later blocks can be slightly less guided to build student confidence.

For each block include:
- A clear, educational "instruction"
- The exact "code" snippet for that step
- Two helpful hints (hint1, hint2) that guide without giving away the full answer

Output ONLY a raw JSON object — no markdown, no code fences, no extra text before or after.
Use exactly this shape (replace ALL angle-bracketed placeholders with real content):

{
  "blocks": [
    {
      "id": 1,
      "type": "<block type>",
      "instruction": "<pedagogical instruction explaining why this step exists>",
      "code": "<exact code snippet from the function body>",
      "hint1": "<first hint without giving away the answer>",
      "hint2": "<second hint that goes a bit further>"
    }
  ]
}`;
}

// Placeholder strings the model sometimes echoes back from the prompt template.
// If detected, we treat the response as invalid and throw so the caller retries.
const EXPLANATION_PLACEHOLDERS = [
    'plain english explanation of what this function does and how',
    '<your explanation here>',
    'your explanation here',
];

function isPlaceholder(value: string): boolean {
    const lower = value.toLowerCase().trim();
    return EXPLANATION_PLACEHOLDERS.some(p => lower.startsWith(p));
}

function parseExplanationResponse(raw: string, functionName: string): ExplanationResult {
    try {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);

        const explanation: string = parsed.explanation ?? '';
        const callInfo: string = parsed.callInfo ?? '';

        // Detect template echo — model returned placeholder text verbatim
        if (isPlaceholder(explanation)) {
            throw new Error('Model echoed the prompt template. Retrying.');
        }

        return {
            functionName,
            explanation,
            concepts: parsed.concepts ?? [],
            callInfo,
        };
    } catch (err: any) {
        // If parsing failed OR we detected a placeholder, re-throw so the
        // caller (explainFunction) surfaces a real error to the webview.
        const match = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
        const explanation = match ? match[1] : raw;
        if (isPlaceholder(explanation)) {
            throw new Error(
                'The model returned an incomplete response. Please try again.'
            );
        }
        return {
            functionName,
            explanation,
            concepts: [],
            callInfo: '',
        };
    }
}

function parsePracticeResponse(raw: string, functionName: string): PracticeResult {
    try {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);

        return {
            functionName,
            blocks: parsed.blocks ?? [],
        };
    } catch (err) {
        console.error('PRACTICE PARSE ERROR', err);
        console.log('RAW PRACTICE RESPONSE:', raw);
        return {
            functionName,
            blocks: [],
        };
    }
}

function parseFileOverview(raw: string): FileOverviewResult {
    try {
        let cleaned = raw
            .replace(/```json|```/g, '')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .trim();

        // Extract JSON block if there's extra text
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            cleaned = jsonMatch[0];
        }

        const parsed = JSON.parse(cleaned);

        return {
            summary: parsed.summary ?? 'No summary available.',
            responsibilities: Array.isArray(parsed.responsibilities) ? parsed.responsibilities : [],
            patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
        };
    } catch (err) {
        console.error('FILE OVERVIEW PARSE ERROR', err);
        console.log('RAW RESPONSE:', raw.substring(0, 600));

        return {
            summary: 'Could not generate file overview.',
            responsibilities: [],
            patterns: [],
        };
    }
}
