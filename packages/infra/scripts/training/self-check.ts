// The self-check that training matches use (TR-001; D236, D243, D248): before anything is written,
// one row of each chosen job goes through the app's real OpenAI-compatible text model, with a
// stand-in for the network, to prove the rows hold exactly what the app sends.
// - Set-up: a stand-in `fetch` and a SerialGate of its own, a dummy address and key. The stand-in
//   records the request body and answers with the row's assistant text as a chat completion.
//   Nothing leaves the process: there is no network call, and the client's own fetch guard refuses
//   any address outside the dummy one.
// - It passes when the body's `messages` are exactly the row's system and user texts, in that order
//   (a string, or the SDK's one-text-part form, compared as text), `chat_template_kwargs.
//   enable_thinking` is false, and the answer the client reads back passes the job's schema and is
//   the row's answer.
// - The problems it gives name the job and what differed, never any row text.
import { OpenAiCompatibleTextModel } from '../../../api/src/ai/openai-compatible-text-model.js';
import type { FetchLike } from '../../../api/src/ai/ollama-provider.js';
import { SerialGate } from '../../../api/src/ai/serial-gate.js';
import { createLogger } from '../../../api/src/common/logger.js';
import type { JobBuilder, TrainingExample } from './rows.js';

/** A dummy address and key: the stand-in answers, so nothing is ever sent to them. */
export const SELF_CHECK_BASE_URL = 'http://127.0.0.1:9/v1';
export const SELF_CHECK_API_KEY = 'train-data-self-check'; // secret-scan: allow (a dummy, never sent)
export const SELF_CHECK_MODEL = 'train-data-self-check';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A message's text: its string content, or the text of its one text part. */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length === 1) {
    const part: unknown = content[0];
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') return part['text'];
  }
  return null;
}

/** A chat completion holding `text` as the assistant's answer. */
function completion(text: string): Response {
  const body = {
    id: 'train-data-self-check',
    object: 'chat.completion',
    created: 0,
    model: SELF_CHECK_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** An error in a few words: its name and code only. */
function describeError(err: unknown): string {
  if (!isRecord(err) && !(err instanceof Error)) return 'unknown error';
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e.name === 'string' ? e.name : 'Error';
  return typeof e.code === 'string' ? `${name} ${e.code}` : name;
}

/** What the request body holds that differs from the row: none when it matches. */
function bodyProblems(body: unknown, example: TrainingExample): string[] {
  if (!isRecord(body)) return ['the request body is not a JSON object'];
  const problems: string[] = [];
  const messages = body['messages'];
  if (!Array.isArray(messages)) {
    problems.push('the request has no messages list');
  } else {
    if (messages.length !== 2) problems.push(`the request sent ${messages.length} message(s), not 2 (system, user)`);
    const expected = [
      { role: 'system', text: example.system },
      { role: 'user', text: example.user },
    ];
    expected.forEach((want, i) => {
      const sent: unknown = messages[i];
      if (!isRecord(sent)) {
        problems.push(`message ${i + 1} is missing`);
        return;
      }
      if (sent['role'] !== want.role) problems.push(`message ${i + 1} is not the ${want.role} message`);
      const text = messageText(sent['content']);
      if (text === null) problems.push(`the ${want.role} message is not text`);
      else if (text !== want.text) problems.push(`the ${want.role} message differs from the row's ${want.role} text`);
    });
  }
  const kwargs = body['chat_template_kwargs'];
  if (!isRecord(kwargs) || kwargs['enable_thinking'] !== false) {
    problems.push('the request does not set chat_template_kwargs.enable_thinking to false');
  }
  return problems;
}

/**
 * Sends one example through the app's real OpenAI-compatible text model with a stand-in for the
 * network. The problems found, each naming the job; empty when the example matches use.
 */
export async function selfCheck(builder: JobBuilder, example: TrainingExample): Promise<string[]> {
  const bodies: unknown[] = [];
  let unreadableBody = false;
  const standIn: FetchLike = async (_input, init) => {
    const raw = init?.body;
    if (typeof raw === 'string') {
      try {
        bodies.push(JSON.parse(raw) as unknown);
      } catch {
        unreadableBody = true;
      }
    } else {
      unreadableBody = true;
    }
    return completion(example.assistant);
  };
  const model = new OpenAiCompatibleTextModel({
    connection: { baseUrl: SELF_CHECK_BASE_URL, apiKey: SELF_CHECK_API_KEY },
    model: SELF_CHECK_MODEL,
    fetch: standIn,
    gate: new SerialGate(),
    // The client's log lines (model, timings, counts) go nowhere: the output is the command's own.
    log: createLogger({ write: () => undefined }),
  });

  const problems: string[] = [];
  let value: unknown;
  let answered = false;
  try {
    value = (await model.generate(example.request)).value;
    answered = true;
  } catch (err) {
    problems.push(`the app's client did not take the row's answer (${describeError(err)})`);
  }
  if (unreadableBody) problems.push('the request body is not JSON text');
  if (bodies.length !== 1 && !unreadableBody) problems.push(`the client sent ${bodies.length} request(s), not 1`);
  if (bodies.length >= 1) problems.push(...bodyProblems(bodies[0], example));
  if (answered) {
    const answerProblem = builder.checkAnswer(value, example);
    if (answerProblem !== null) problems.push(answerProblem);
  }
  return problems.map((problem) => `${builder.job}: ${problem}`);
}
