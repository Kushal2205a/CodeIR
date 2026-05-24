import axios from 'axios';
import { FunctionNode } from './parser/extract';

const INVOKE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL      = 'moonshotai/kimi-k2.6';

export interface ExplanationResult {
  functionName: string;
  explanation:  string;
  concepts:     string[];
  callInfo:     string;
}

export interface PracticeBlock {
  id:          number;
  instruction: string;
  code:        string;
  hint1:       string;
  hint2:       string;
}

export interface PracticeResult {
  functionName: string;
  blocks:       PracticeBlock[];
}

async function callKimi(prompt: string, maxTokens: number = 2048): Promise<string> {
  const response = await axios.post(
    INVOKE_URL,
    {
      model:      MODEL,
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
      top_p:       1.0,
      stream:      false,
      chat_template_kwargs: { thinking: true },
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Accept':        'application/json',
      },
    }
  );

  return response.data.choices?.[0]?.message?.content ?? '';
}

export async function explainFunction(fn: FunctionNode): Promise<ExplanationResult> {
  const raw = await callKimi(buildExplanationPrompt(fn), 1024);
  return parseExplanationResponse(raw, fn.name);
}

export async function generatePracticeBlocks(fn: FunctionNode): Promise<PracticeResult> {
  const raw = await callKimi(buildPracticePrompt(fn), 2048);
  return parsePracticeResponse(raw, fn.name);
}

function buildExplanationPrompt(fn: FunctionNode): string {
  return `You are a programming tutor. Explain the following function clearly and concisely.

Function name: ${fn.name}
Signature: ${fn.signature}
Body:
${fn.body}

Respond in this exact JSON format with no extra text:
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

Respond in this exact JSON format with no extra text:
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
    const parsed  = JSON.parse(cleaned);

    return {
      functionName,
      explanation: parsed.explanation ?? '',
      concepts:    parsed.concepts    ?? [],
      callInfo:    parsed.callInfo    ?? '',
    };
  } catch {
    return {
      functionName,
      explanation: raw,
      concepts:    [],
      callInfo:    '',
    };
  }
}

function parsePracticeResponse(raw: string, functionName: string): PracticeResult {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);

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