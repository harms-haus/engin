import * as readline from 'node:readline';

/**
 * Ask a yes/No question on stdin/stdout, defaulting to `defaultValue` when the
 * user presses return (or stdin closes).
 *
 * Accepts `y`/`yes` (case-insensitive) as affirmative; anything else —
 * including empty input — follows `defaultValue`. Guards against stdin
 * closing without input (EOF, piped input, CI) by resolving `defaultValue`
 * so the process never deadlocks.
 */
export async function promptYesNo(prompt: string, defaultValue: boolean): Promise<boolean> {
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(`${prompt} ${hint} `, (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (normalized === '') {
          resolve(defaultValue);
          return;
        }
        resolve(normalized === 'y' || normalized === 'yes');
      });
      rl.on('close', () => resolve(defaultValue));
    });
  } finally {
    rl.close();
  }
}
