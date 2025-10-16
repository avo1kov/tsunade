import { Telegraf } from 'telegraf';
import fs from 'node:fs/promises';
import path from 'node:path';

export type TelegramEnv = {
  botToken: string;
  chatId: string;
};

export function getTelegramEnv(): TelegramEnv {
  const botToken = (process.env.TSUNADE__TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TSUNADE__TELEGRAM_CHAT_ID || '').trim();
  if (!botToken) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }
  if (!chatId) {
    throw new Error('Missing TELEGRAM_CHAT_ID');
  }
  return { botToken, chatId };
}

export async function sendPhoto(filePath: string, caption?: string): Promise<void> {
  const { botToken, chatId } = getTelegramEnv();
  const bot = new Telegraf(botToken);
  const buffer = await fs.readFile(filePath);
  const options: Parameters<typeof bot.telegram.sendPhoto>[2] = {} as any;
  if (typeof caption === 'string') {
    (options as any).caption = caption;
  }
  await bot.telegram.sendPhoto(chatId, { source: buffer }, options);
}

export async function sendText(message: string): Promise<void> {
  const { botToken, chatId } = getTelegramEnv();
  const bot = new Telegraf(botToken);
  await bot.telegram.sendMessage(chatId, message);
}

export async function sendDocument(filePath: string, caption?: string): Promise<void> {
  const { botToken, chatId } = getTelegramEnv();
  const bot = new Telegraf(botToken);
  const buffer = await fs.readFile(filePath);
  const options: Parameters<typeof bot.telegram.sendDocument>[2] = {} as any;
  if (typeof caption === 'string') {
    (options as any).caption = caption;
  }
  const filename = path.basename(filePath);
  await bot.telegram.sendDocument(chatId, { source: buffer, filename }, options);
}
