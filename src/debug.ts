export type Debugger = (...args: unknown[]) => void;

export function createDebug(namespace: string): Debugger {
  const debugEnv = process.env.DEBUG ?? '';
  const enabled =
    debugEnv === '*' ||
    debugEnv.split(',').some((pattern) => {
      const trimmed = pattern.trim();
      return trimmed === 'agy-hud' || trimmed === 'agy-hud:*' || trimmed === `agy-hud:${namespace}` || trimmed === 'claude-hud' || trimmed === 'claude-hud:*';
    });

  if (!enabled) {
    return () => {};
  }

  return (...args: unknown[]) => {
    console.error(`[agy-hud:${namespace}]`, ...args);
  };
}
