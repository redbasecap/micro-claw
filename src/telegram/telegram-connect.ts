import QRCode from "qrcode";
import type { TelegramUser } from "./telegram-client.js";

export interface TelegramConnectInfo {
  botId: number;
  botUsername: string;
  botName: string;
  connectUrl: string;
  qrTerminal: string;
}

export function buildTelegramConnectUrl(botUsername: string): string {
  return `https://t.me/${botUsername}`;
}

export async function createTelegramConnectInfo(user: TelegramUser): Promise<TelegramConnectInfo> {
  if (!user.username) {
    throw new Error("Telegram bot username is missing from getMe(). Set a public bot username in BotFather.");
  }

  const connectUrl = buildTelegramConnectUrl(user.username);
  const qrTerminal = await QRCode.toString(connectUrl, {
    type: "terminal",
    small: true
  });

  return {
    botId: user.id,
    botUsername: user.username,
    botName: user.first_name ?? user.username,
    connectUrl,
    qrTerminal
  };
}

export function formatTelegramConnectInfo(info: TelegramConnectInfo): string {
  return [
    `Bot: @${info.botUsername}`,
    `Name: ${info.botName}`,
    `Open: ${info.connectUrl}`,
    "",
    "Scan this QR code in Telegram:",
    info.qrTerminal.trimEnd()
  ].join("\n");
}
