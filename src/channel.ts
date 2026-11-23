import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { WrittenSnapshot } from './external-usage.ts';
import type { AgyQuotaProbe, StdinData } from './types.ts';

export type Probe =
  | 'git.status'
  | 'git.numstat'
  | 'git.branch'
  | 'git.describe'
  | 'git.hooks'
  | 'git.repo'
  | 'jj'
  | 'memory'
  | 'extra'
  | 'usage.read'
  | 'usage.target'
  | 'agy.quota'
  | 'agy.unicode';

export type Ask = (names: Probe[]) => Promise<Record<Probe, unknown>>;

export interface Paths {
  data: string;
  config: string;
  override: string;
  legacyConfig: string;
  heartbeat: string;
  claudeJson: string;
  user: {
    claudeMd: string;
    geminiMd: string;
    rules: string;
    agyRules: string;
    agents?: string;
    agyConfigAgents?: string;
    agyAgents?: string;
    agyCliAgents?: string;
    settings: string;
    agySettings: string;
    mcpConfig?: string;
    agyMcpConfig?: string;
    agyHookFiles?: string[];
  };
  project: {
    claudeMd: string;
    localMd: string;
    agentsMd: string;
    geminiMd: string;
    memoryMd: string;
    mcpJson: string;
    localAgyHudConfig: string;
    dotClaudeMd: string | null;
    dotLocalMd: string;
    rules: string | null;
    geminiRules: string;
    agentsRules: string;
    cursorRules: string;
    githubRules: string;
    agents?: string | null;
    geminiAgents?: string;
    agentsAgents?: string;
    settings: string | null;
    localSettings: string;
  } | null;
  projectMemory: string | null;
  transcript: string | null;
  subagents: string | null;
  agySubagentTranscripts?: Record<string, string>;
  todoFiles?: string[];
}

export interface Facts {
  runtime: {
    name: string;
    version: string;
    path: string;
    supported: boolean;
  };
  runtimes: Array<{ name: string; version: string; path: string }>;
  plugin: {
    root: string;
    version: string | null;
  };
  configPath: string;
  undoPath: string;
  cwd: string;
  account: {
    email: string | null;
    tier: string | null;
  };
  heartbeat: {
    at?: number;
    runtime?: string;
    path?: string;
    outcome?: string;
    columns?: number | null;
    stdin?: StdinData | null;
  } | null;
  agyQuota?: AgyQuotaProbe | null;
}

export interface CommandRequest {
  name: 'doctor' | 'schema' | 'preview' | 'set' | 'preset' | 'report';
  args: string[];
  facts: Facts;
}

export interface InitMessage {
  stdin: StdinData | null;
  now: number;
  paths: Paths;
  command?: CommandRequest;
}

export interface ReplyMessage {
  lines: string[];
  snapshot?: WrittenSnapshot | null;
  config?: Record<string, unknown>;
  failed?: boolean;
}

export interface Channel {
  init: Promise<InitMessage>;
  ask: Ask;
  reply: (msg: ReplyMessage) => void;
}

function createFdChannel(): Channel {
  let nextId = 1;
  let closed = false;
  let remainder: Buffer = Buffer.alloc(0);
  const pending = new Map<number, (answers: Record<string, unknown>) => void>();

  const readOneChunk = (): Promise<Buffer | null> =>
    new Promise((resolve) => {
      const buf = Buffer.allocUnsafe(8192);
      fs.read(0, buf, 0, buf.length, null, (err, bytesRead) => {
        if (err || bytesRead <= 0) resolve(null);
        else resolve(buf.subarray(0, bytesRead));
      });
    });

  const nextLine = async (): Promise<string | null> => {
    while (!closed) {
      const nl = remainder.indexOf(0x0a);
      if (nl !== -1) {
        const line = remainder.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        remainder = remainder.subarray(nl + 1);
        return line;
      }
      const chunk = await readOneChunk();
      if (chunk === null) {
        if (remainder.length > 0) {
          const line = remainder.toString('utf8').replace(/\r$/, '');
          remainder = Buffer.alloc(0);
          return line;
        }
        return null;
      }
      remainder = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
    }
    return null;
  };

  let pumpActive = false;
  const dispatchLine = (raw: string): void => {
    if (!raw.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const done = pending.get(msg.id)!;
      pending.delete(msg.id);
      done((msg.answers && typeof msg.answers === 'object' ? msg.answers : {}) as Record<string, unknown>);
    }
  };

  const pumpAnswers = async (): Promise<void> => {
    if (pumpActive) return;
    pumpActive = true;
    try {
      while (!closed && pending.size > 0) {
        const raw = await nextLine();
        if (raw === null) {
          for (const done of pending.values()) done({});
          pending.clear();
          return;
        }
        dispatchLine(raw);
      }
    } finally {
      pumpActive = false;
    }
  };

  const init = (async (): Promise<InitMessage> => {
    while (!closed) {
      const raw = await nextLine();
      if (raw === null) throw new Error('channel closed before init message');
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if ('paths' in msg) return msg as unknown as InitMessage;
    }
    throw new Error('channel closed before init message');
  })();

  const ask: Ask = (names) => {
    const unique = [...new Set(names)];
    if (unique.length === 0 || closed) return Promise.resolve({} as Record<Probe, unknown>);
    const id = nextId++;
    return new Promise<Record<Probe, unknown>>((resolve) => {
      pending.set(id, (answers) => resolve(answers as Record<Probe, unknown>));
      fs.writeSync(1, `${JSON.stringify({ id, ask: unique })}\n`);
      void pumpAnswers();
    });
  };

  const reply = (msg: ReplyMessage): void => {
    closed = true;
    for (const done of pending.values()) done({});
    pending.clear();
    fs.writeSync(1, `${JSON.stringify(msg)}\n`);
  };

  return { init, ask, reply };
}

export function createChannel(
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): Channel {
  // Inside fence.mjs cage, process.stdin is sealed to undefined so logic reads fd 0 via node:fs.
  if (!input || !output) return createFdChannel();

  let nextId = 1;
  const pending = new Map<number, (answers: Record<string, unknown>) => void>();
  let resolveInit!: (msg: InitMessage) => void;
  let rejectInit!: (err: Error) => void;
  let initSettled = false;

  const init = new Promise<InitMessage>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (raw) => {
    if (!raw.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!initSettled && 'paths' in msg) {
      initSettled = true;
      resolveInit(msg as unknown as InitMessage);
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const done = pending.get(msg.id)!;
      pending.delete(msg.id);
      done((msg.answers && typeof msg.answers === 'object' ? msg.answers : {}) as Record<string, unknown>);
    }
  });

  rl.once('close', () => {
    if (!initSettled) {
      initSettled = true;
      rejectInit(new Error('channel closed before init message'));
    }
    for (const done of pending.values()) done({});
    pending.clear();
  });

  const ask: Ask = (names) => {
    const unique = [...new Set(names)];
    if (unique.length === 0) return Promise.resolve({} as Record<Probe, unknown>);
    const id = nextId++;
    return new Promise<Record<Probe, unknown>>((resolve) => {
      pending.set(id, (answers) => resolve(answers as Record<Probe, unknown>));
      output.write(`${JSON.stringify({ id, ask: unique })}\n`);
    });
  };

  const reply = (msg: ReplyMessage): void => {
    output.write(`${JSON.stringify(msg)}\n`);
    rl.close();
  };

  return { init, ask, reply };
}
