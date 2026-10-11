import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface SauronConfig {
  defaultModel: string;
  smartModel: string;
  cheapModel: string;
  customModelsPath: string;
  sessionDir: string;
  pentestingSkillsRepo: string;
  sauronDir: string;
}

export class ConfigManager {
  public getSauronDir(): string {
    const customHome = process.env.SAURON_HOME;
    const baseDir = customHome || join(homedir(), '.sauron');
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
    return baseDir;
  }

  public getConfig(): SauronConfig {
    const sauronDir = this.getSauronDir();
    const sessionDir = join(sauronDir, 'sessions');
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }

    return {
      defaultModel: process.env.SAURON_MODEL || 'auto',
      smartModel: process.env.SAURON_SMART_MODEL || 'gemini-3.1-pro-high', // never Claude by default — see router/index.ts policy note
      cheapModel: process.env.SAURON_CHEAP_MODEL || 'gemini-3.5-flash-lite',
      customModelsPath: join(sauronDir, 'custom_models.json'),
      sessionDir,
      sauronDir,
      pentestingSkillsRepo: process.env.SAURON_PENTESTING_SKILLS_REPO || 'https://github.com/crowx01/Pentesting-Skills'
    };
  }

  public getApiKey(provider: string): string | undefined {
    const envVarName = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    if (process.env[envVarName]) {
      return process.env[envVarName];
    }
    
    switch (provider.toLowerCase()) {
      case 'openai':
        return process.env.OPENAI_API_KEY;
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY;
      case 'gemini':
      case 'google':
        return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      case 'openrouter':
        return process.env.OPENROUTER_API_KEY;
      case 'cohere':
        return process.env.COHERE_API_KEY;
      case 'xai':
        return process.env.XAI_API_KEY;
      case 'azure':
        return process.env.AZURE_OPENAI_API_KEY;
      default:
        return undefined;
    }
  }

  public loadCustomModels(): Record<string, any>[] {
    const conf = this.getConfig();
    if (existsSync(conf.customModelsPath)) {
      try {
        const raw = readFileSync(conf.customModelsPath, 'utf-8');
        return JSON.parse(raw);
      } catch (err) {
        return [];
      }
    }
    return [];
  }
}

export const configManager = new ConfigManager();
