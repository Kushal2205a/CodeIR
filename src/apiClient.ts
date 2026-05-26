import axios from 'axios';
import * as vscode from 'vscode';
import { FunctionNode } from './parser/extract';

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
        nvidiaApiKey: cfg.get<string>('nvidiaApiKey') ?? '',
        ollamaBaseUrl: cfg.get<string>('ollamaBaseUrl') ?? 'http://localhost:11434',
        ollamaModel: cfg.get<string>('ollamaModel') ?? 'llama3',
    };
}

async function callNvidia(prompt: string, maxTokens: number): Promise<string> {
    const { nvidiaApiKey } = getConfig();

    if (!nvidiaApiKey) {
        throw new Error('NVIDIA API key not set. Go to Settings and set learntovibe.nvidiaApiKey.');
    }

    const response = await axios.post(
        'https://integrate.api.nvidia.com/v1/chat/completions',
        {
            model: 'moonshotai/kimi-k2.6',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
            top_p: 1.0,
            stream: false,
            chat_template_kwargs: { thinking: false },
        },
        {
            headers: {
                'Authorization': `Bearer ${nvidiaApiKey}`,
                'Accept': 'application/json',
            },
            timeout: 200000, // 60 s — prevents indefinite hangs
        }
    );

    console.log(response);

    const raw = response.data.choices?.[0]?.message?.content ?? '';
    return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function callOllama(prompt: string, maxTokens: number): Promise<string> {
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
export async function callLLM(prompt: string, maxTokens: number = 2048): Promise<string> {
    const { provider } = getConfig();

    switch (provider) {
        case 'ollama': return callOllama(prompt, maxTokens);
        case 'nvidia': return callNvidia(prompt, maxTokens);
        default: throw new Error(`Unknown provider: ${provider}`);
    }
}

export async function generateFileOverview(
    functions: FunctionNode[]
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

    const raw = await callLLM(prompt, 1024);
    return parseFileOverview(raw);
}
export async function explainFunction(fn: FunctionNode): Promise<ExplanationResult> {
    const raw = await callLLM(buildExplanationPrompt(fn), 2048);
    return parseExplanationResponse(raw, fn.name);
}

export async function generatePracticeBlocks(fn: FunctionNode): Promise<PracticeResult> {
    console.log('Generating practice blocks...');
    const raw = await callLLM(buildPracticePrompt(fn), 2048);
    console.log('RAW RESPONSE:', raw);
    return parsePracticeResponse(raw, fn.name);
}

function buildExplanationPrompt(fn: FunctionNode): string {
    return `You are a programming tutor. Explain the following function clearly and concisely for a student who is learning to code.

Function name: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Your task:
1. Write a plain-English explanation of what this function does step by step, and why it is useful.
2. List 2-4 key programming concepts demonstrated by this function.
3. Describe where and how this function would typically be called in a real application.

Output ONLY a raw JSON object — no markdown, no code fences, no extra text before or after.
The JSON must use exactly these keys:

{
  "explanation": "<your explanation here>",
  "concepts": ["<concept A>", "<concept B>"],
  "callInfo": "<your call-site description here>"
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