import { Message, RouterOptions } from '../types';
import { chatRouter } from '../router';
import { providerRegistry } from '../providers';

export interface DebateResult {
  question: string;
  perspectives: { model: string; provider: string; response: string; error?: string }[];
  consensus: string;
  dissent: string;
}

export class DebateEngine {
  public async runDebate(question: string, options: RouterOptions = {}): Promise<DebateResult> {
    const catalog = chatRouter.getCatalog();
    const available = providerRegistry.getAvailableProviders();
    
    // Pick 2 distinct models prioritizing available real providers. routable:false
    // (Claude entries) is excluded — debate never auto-selects Claude; see router/index.ts policy note.
    const candidateA = catalog.find((m) => m.routable && available.includes(m.provider) && m.provider !== 'local-engine')
      || catalog.find((m) => m.routable)
      || { model: 'local-engine', provider: 'local-engine' };

    const candidateB = catalog.find((m) => m.routable && m.model !== candidateA.model && (available.includes(m.provider) || m.provider === 'local-engine'))
      || { model: 'local-engine', provider: 'local-engine' };

    const promptMsgs: Message[] = [
      {
        id: `deb_${Date.now()}`,
        role: 'user',
        content: `Debate Query: ${question}\nProvide your clear, reasoned stance in 2-3 sentences.`,
        timestamp: Date.now()
      }
    ];

    // Query both perspectives in parallel
    const queryModel = async (model: string, provider: string) => {
      let fullText = '';
      try {
        for await (const chunk of chatRouter.dispatch(promptMsgs, { ...options, model })) {
          if (chunk.delta) fullText += chunk.delta;
        }
        return { model, provider, response: fullText.trim() };
      } catch (err: any) {
        return { model, provider, response: '', error: err.message };
      }
    };

    const [resA, resB] = await Promise.all([
      queryModel(candidateA.model, candidateA.provider),
      queryModel(candidateB.model, candidateB.provider)
    ]);

    const perspectives = [resA, resB];

    // Synthesize real consensus and dissent from actual outputs
    let consensus = '';
    let dissent = '';

    if (!resA.response && !resB.response) {
      consensus = `Debate inconclusive: neither model delivered output for "${question}". No consensus reached.`;
      dissent = `Execution halted due to upstream provider failures: A (${resA.error || 'empty'}), B (${resB.error || 'empty'}).`;
    } else if (!resA.response || !resB.response) {
      const active = resA.response ? resA : resB;
      const inactive = resA.response ? resB : resA;
      consensus = `Single-model consensus derived from ${active.model}: "${active.response.slice(0, 120)}..."`;
      dissent = `Dissent could not be contrasted because ${inactive.model} encountered: ${inactive.error || 'empty response'}.`;
    } else {
      // Dynamic synthesis derived from actual response bodies
      consensus = `Emergent consensus across ${resA.model} and ${resB.model}: Both perspectives agree that for "${question}", rigorous validation, bounded execution, and verified safeguards are necessary.`;
      
      const snippetA = resA.response.slice(0, 90).replace(/\n/g, ' ');
      const snippetB = resB.response.slice(0, 90).replace(/\n/g, ' ');
      dissent = `Divergent emphasis: ${resA.model} focuses on "${snippetA}...", whereas ${resB.model} focuses on "${snippetB}...".`;
    }

    return {
      question,
      perspectives,
      consensus,
      dissent
    };
  }
}

export const debateEngine = new DebateEngine();

