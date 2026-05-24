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
}

export interface PracticeResult {
    functionName: string;
    blocks: PracticeBlock[];
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
        }
    );

    const raw = response.data.choices?.[0]?.message?.content ?? '';
    return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function callOllama(prompt: string, maxTokens: number): Promise<string> {
  const { ollamaBaseUrl, ollamaModel } = getConfig();

  const payload = JSON.stringify({
    model:    ollamaModel,
    messages: [{ role: 'user', content: prompt }],
    stream:   false,
    options: {
      num_predict: maxTokens,
      temperature: 0.7,
    },
  });

  console.log('Payload being sent:', payload);
  console.log('URL:', `${ollamaBaseUrl}/api/chat`);

  try {
    const response = await axios({
      method:  'post',
      url:     `${ollamaBaseUrl}/api/chat`,
      data:    payload,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });

    return response.data.message?.content ?? '';
  } catch (err: any) {
    console.log('Status:', err?.response?.status);
    console.log('Response data:', JSON.stringify(err?.response?.data));
    console.log('Request data:', JSON.stringify(err?.config?.data));
    throw new Error(`Ollama failed: ${err?.message}`);
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

export async function explainFunction(fn: FunctionNode): Promise<ExplanationResult> {
    const raw = await callLLM(buildExplanationPrompt(fn), 2048);
    return parseExplanationResponse(raw, fn.name);
}

export async function generatePracticeBlocks(fn: FunctionNode): Promise<PracticeResult> {
    const raw = await callLLM(buildPracticePrompt(fn), 2048);
    return parsePracticeResponse(raw, fn.name);
}

function buildExplanationPrompt(fn: FunctionNode): string {
    return `You are a programming tutor. Explain the following function clearly and concisely.

Function name: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Respond in this exact JSON format with no extra text, no markdown fences:
{
  "explanation": "plain english explanation of what this function does and how",
  "concepts": ["concept1", "concept2", "concept3"],
  "callInfo": "where and how this function is typically called"
}`;
}

function buildPracticePrompt(fn: FunctionNode): string {
    return `You are a programming tutor. Break this function into logical learning blocks for a student to reconstruct.

Function name: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Rules:
- Do NOT include import statements or boilerplate as blocks.
- Focus on logic, flow, conditions, and data transformations.
- Each block should be a meaningful unit of logic, not a single character.
- Hints should guide without giving away the answer.
- Keep code in each block to the exact source lines, no modifications.

Respond in this exact JSON format with no extra text, no markdown fences:
{
  "blocks": [
    {
      "id": 1,
      "instruction": "what the student should write and why",
      "code": "exact source lines for this block",
      "hint1": "first nudge without giving it away",
      "hint2": "stronger hint, still not the full answer"
    }
  ]
}`;
}

function parseExplanationResponse(raw: string, functionName: string): ExplanationResult {
    try {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);

        return {
            functionName,
            explanation: parsed.explanation ?? '',
            concepts: parsed.concepts ?? [],
            callInfo: parsed.callInfo ?? '',
        };
    } catch {
        const match = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
        return {
            functionName,
            explanation: match ? match[1] : raw,
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
    } catch {
        return {
            functionName,
            blocks: [],
        };
    }
}