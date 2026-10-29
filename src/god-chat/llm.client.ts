import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type LlmOptions = { temperature?: number; maxTokens?: number };

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const TIMEOUT_MS = 25_000;

/**
 * Minimal OpenAI-compatible chat completions client (DeepSeek by default).
 * The API key stays on the server; nothing here is exposed to the mobile app.
 */
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);
  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return Boolean(this.config.get<string>('DEEPSEEK_API_KEY')?.trim());
  }

  async complete(messages: LlmMessage[], options: LlmOptions = {}): Promise<string> {
    const apiKey = this.config.get<string>('DEEPSEEK_API_KEY')?.trim();
    if (!apiKey) throw new ServiceUnavailableException('Chat with God is not configured');
    const baseUrl = (this.config.get<string>('DEEPSEEK_BASE_URL')?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
    const model = this.config.get<string>('DEEPSEEK_MODEL')?.trim() || DEFAULT_MODEL;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 600,
          stream: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn({ event: 'god_chat_llm_unreachable', type: (error as Error)?.name });
      throw new ServiceUnavailableException('Chat with God is unavailable');
    }
    if (!response.ok) {
      // Never log the provider body: it can echo the prompt.
      this.logger.warn({ event: 'god_chat_llm_failed', status: response.status });
      throw new ServiceUnavailableException('Chat with God is unavailable');
    }
    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim())
      throw new ServiceUnavailableException('Chat with God is unavailable');
    return reply.trim();
  }
}
