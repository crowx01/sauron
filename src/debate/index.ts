import { randomUUID } from 'crypto';
import { DebateOptions, DebateParticipant, DebateResult, Message } from '../types';
import { chatRouter } from '../router';

const ARGUMENT_WORD_CAP = 150;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'with',
  'as', 'this', 'that', 'it', 'its', 'by', 'at', 'from', 'into', 'than', 'can', 'will', 'should',
  'would', 'could', 'you', 'your', 'we', 'our', 'i', 'they', 'their', 'not', 'if', 'so', 'such',
  'these', 'those', 'also', 'more', 'most', 'use', 'used', 'using'
]);

function msg(role: Message['role'], content: string): Message {
  return { id: `m_${randomUUID().slice(0, 8)}`, role, content, timestamp: Date.now() };
}

/** Significant (non-stopword, length>3) lowercase word frequencies for one argument. */
function wordFreq(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const words = text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return freq;
}

/** Default seats when the caller doesn't pin specific models: up to 3 distinct-provider catalog entries, highest intelligence first. */
function pickDefaultSeatModels(): string[] {
  const catalog = chatRouter.getCatalog().filter((m) => m.provider !== 'local-engine');
  const sorted = [...catalog].sort((a, b) => b.intelligence - a.intelligence);
  const seats: string[] = [];
  const usedProviders = new Set<string>();
  for (const entry of sorted) {
    if (usedProviders.has(entry.provider)) continue;
    seats.push(entry.model);
    usedProviders.add(entry.provider);
    if (seats.length >= 3) break;
  }
  return seats.length > 0 ? seats : ['local-engine'];
}

/**
 * Multi-model debate & consensus: dispatches a question to 2-3 routed models (seats), then
 * aggregates their arguments into agreements/dissents and a synthesis.
 */
export class DebateEngine {
  public async run(question: string, options: DebateOptions = {}): Promise<DebateResult> {
    const seatModels = options.seats && options.seats.length > 0 ? options.seats : pickDefaultSeatModels();

    const participants = await Promise.all(
      seatModels.map((model) => this.gatherArgument(question, model, options.signal))
    );

    const { agreements, dissents } = this.compare(participants);
    const synthesis = await this.synthesize(question, participants, agreements, dissents, options.signal);

    return { question, participants, agreements, dissents, synthesis };
  }

  private async gatherArgument(question: string, model: string, signal?: AbortSignal): Promise<DebateParticipant> {
    const route = chatRouter.route({ model });
    const messages: Message[] = [
      msg(
        'system',
        `You are one voice in a multi-model debate. State your position in at most ${ARGUMENT_WORD_CAP} words. Be concrete and opinionated.`
      ),
      msg('user', question)
    ];

    let buffer = '';
    let error: string | undefined;
    for await (const chunk of chatRouter.dispatch(messages, { model, signal })) {
      if (chunk.delta) buffer += chunk.delta;
      if (chunk.error && !buffer.trim()) error = chunk.error;
    }

    return { model: route.primaryModel, provider: route.primaryProvider, argument: buffer.trim(), error };
  }

  /** Word-overlap heuristic: no second LLM call needed to spot where participants converge/diverge. */
  private compare(participants: DebateParticipant[]): { agreements: string[]; dissents: string[] } {
    const live = participants.filter((p) => p.argument && !p.error);
    const freqs = live.map((p) => wordFreq(p.argument));

    const shared = new Map<string, number>();
    const unique = new Map<string, { word: string; count: number; owner: number }>();

    const allWords = new Set<string>();
    for (const f of freqs) for (const w of f.keys()) allWords.add(w);

    for (const w of allWords) {
      const holders = freqs.reduce((n, f) => n + (f.has(w) ? 1 : 0), 0);
      const totalCount = freqs.reduce((n, f) => n + (f.get(w) || 0), 0);
      if (holders >= 2) {
        shared.set(w, totalCount);
      } else if (holders === 1) {
        const ownerIdx = freqs.findIndex((f) => f.has(w));
        const existing = unique.get(w);
        if (!existing || totalCount > existing.count) {
          unique.set(w, { word: w, count: totalCount, owner: ownerIdx });
        }
      }
    }

    const agreements = [...shared.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => `Shared emphasis on "${w}" across ${live.length >= 2 ? 'multiple models' : 'the panel'}.`);

    const byOwner = new Map<number, string[]>();
    for (const { word, owner } of unique.values()) {
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner)!.push(word);
    }

    const dissents: string[] = [];
    for (const [owner, words] of byOwner.entries()) {
      const top = words.slice(0, 3);
      if (top.length === 0) continue;
      dissents.push(`${live[owner].model} uniquely stresses: ${top.join(', ')}.`);
    }

    for (const p of participants) {
      if (p.error) dissents.push(`${p.model} did not provide an argument: ${p.error}.`);
    }

    return { agreements, dissents };
  }

  private async synthesize(
    question: string,
    participants: DebateParticipant[],
    agreements: string[],
    dissents: string[],
    signal?: AbortSignal
  ): Promise<string> {
    const transcript = participants
      .map((p) => `${p.model}: ${p.error ? `(unavailable: ${p.error})` : p.argument}`)
      .join('\n\n');

    const prompt =
      `Debate question: ${question}\n\nParticipant arguments:\n${transcript}\n\n` +
      'In 2-3 sentences, synthesize the consensus and the key point of disagreement, if any.';

    const messages: Message[] = [
      msg('system', 'You are a neutral moderator summarizing a multi-model debate.'),
      msg('user', prompt)
    ];

    let buffer = '';
    for await (const chunk of chatRouter.dispatch(messages, { signal })) {
      if (chunk.delta) buffer += chunk.delta;
    }

    const synthesized = buffer.trim();
    if (synthesized) return synthesized;

    // Fallback when no model produced a usable synthesis: summarize from the heuristic comparison.
    const agreePart = agreements.length ? agreements.join(' ') : 'No strong lexical agreement detected.';
    const dissentPart = dissents.length ? dissents.join(' ') : 'No notable dissent detected.';
    return `${agreePart} ${dissentPart}`.trim();
  }
}

export const debateEngine = new DebateEngine();
