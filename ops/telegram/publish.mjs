import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const messagesDirectory = join(directory, 'messages');
const statePath = join(directory, 'published.json');
const telegramApi = 'https://api.telegram.org';
const messageOptions = {
  parse_mode: 'Markdown',
  disable_web_page_preview: true,
};

export function planActions(files, state) {
  return files.map((file) => {
    const slug = basename(file, '.md');
    const messageId = state.messages?.[slug];
    return {
      slug,
      action: messageId === undefined ? 'send' : 'edit',
      messageId,
    };
  });
}

async function callTelegram(token, method, body) {
  let response;
  try {
    response = await fetch(`${telegramApi}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Telegram ${method} request failed`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram ${method} failed: invalid API response`);
  }
  if (payload.ok === true) return { result: payload.result, notModified: false };
  const description = typeof payload.description === 'string' ? payload.description : `HTTP ${response.status}`;
  if (description.toLowerCase().includes('message is not modified')) {
    return { result: null, notModified: true };
  }
  throw new Error(`Telegram ${method} failed: ${description}`);
}

async function readState() {
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function readMessageFiles() {
  const names = (await readdir(messagesDirectory))
    .filter((name) => name.endsWith('.md'))
    .sort();
  return names.map((name) => ({
    path: join(messagesDirectory, name),
    text: readFile(join(messagesDirectory, name), 'utf8'),
  })).map(async (message) => ({ ...message, text: await message.text }));
}

async function run() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is required');

  const state = await readState();
  if (String(state.chatId) !== chatId) {
    throw new Error(`TELEGRAM_CHAT_ID does not match published.json chatId (${state.chatId})`);
  }

  const messages = await Promise.all(await readMessageFiles());
  const actions = planActions(messages.map(({ path }) => path), state);
  const dryRun = process.argv.includes('--dry-run');
  for (const action of actions) {
    const target = action.messageId === undefined ? 'new message' : `message ${action.messageId}`;
    console.log(`${action.slug}: ${action.action.toUpperCase()} (${target})`);
  }
  if (dryRun) return;

  const nextState = { ...state, messages: { ...state.messages } };
  let createdMessage = false;
  for (const action of actions) {
    const message = messages.find(({ path }) => basename(path, '.md') === action.slug);
    if (!message) throw new Error(`Message file disappeared: ${action.slug}`);
    if (action.action === 'edit') {
      const response = await callTelegram(token, 'editMessageText', {
        chat_id: chatId,
        message_id: action.messageId,
        text: message.text,
        ...messageOptions,
      });
      console.log(
        `${action.slug}: edited message ${action.messageId}${
          response.notModified ? ' (message is not modified)' : ''
        }`,
      );
      continue;
    }
    const response = await callTelegram(token, 'sendMessage', {
      chat_id: chatId,
      text: message.text,
      ...messageOptions,
    });
    const result = response.result;
    if (!result || typeof result.message_id !== 'number') {
      throw new Error(`Telegram sendMessage failed: response did not contain message_id`);
    }
    nextState.messages[action.slug] = result.message_id;
    createdMessage = true;
    if (action.slug === actions[0]?.slug) {
      await callTelegram(token, 'pinChatMessage', {
        chat_id: chatId,
        message_id: result.message_id,
        disable_notification: true,
      });
    }
  }
  if (createdMessage) {
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Telegram publish failed');
    process.exitCode = 1;
  });
}
