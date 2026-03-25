import { toErrorMessage } from "../core/utils.js";

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramClientOptions {
  token: string;
  apiBaseUrl: string;
  timeoutSeconds: number;
}

export class TelegramClient {
  constructor(private readonly options: TelegramClientOptions) {}

  private async request<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.options.apiBaseUrl}/bot${this.options.token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      signal: AbortSignal.timeout(this.options.timeoutSeconds * 1_000),
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}.`);
    }

    const parsed = (await response.json()) as TelegramApiEnvelope<T>;
    if (!parsed.ok || parsed.result === undefined) {
      throw new Error(parsed.description || `Telegram ${method} returned an invalid response.`);
    }

    return parsed.result;
  }

  async getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    try {
      return await this.request<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message"]
      });
    } catch (error) {
      throw new Error(`Telegram getUpdates failed: ${toErrorMessage(error)}`);
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.request("sendMessage", {
        chat_id: chatId,
        text
      });
    } catch (error) {
      throw new Error(`Telegram sendMessage failed: ${toErrorMessage(error)}`);
    }
  }
}
