import { getGlobalConfigDir, initDefaultConfig } from '@harms-haus/engin-engine';

import type { CliOptions } from '../parse-args.js';

export async function initCommand(_options: CliOptions): Promise<void> {
  await initDefaultConfig();
  const globalDir = getGlobalConfigDir();
  console.log('Initialized engin directory structure at ' + globalDir);
}
