import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Project root — used as the resolve base for bare specifiers in external files. */
const projectRoot = resolve(import.meta.dirname, '..');

function discoverRenderers(): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const globalConfigDir = xdgConfigHome ? join(xdgConfigHome, 'engin') : join(homedir(), '.config', 'engin');

  if (!existsSync(globalConfigDir)) {
    return [];
  }

  const workflowsDir = join(globalConfigDir, 'workflows');
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const renderers: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(workflowsDir);
  } catch {
    // Directory may have been removed between existence check and read
    return [];
  }

  for (const entry of entries) {
    const workflowDir = join(workflowsDir, entry);
    let stat;
    try {
      stat = lstatSync(workflowDir);
    } catch {
      // Entry may have been removed between readdir and stat
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;

    const webDir = join(workflowDir, 'web');
    if (!existsSync(webDir)) continue;
    try {
      const webStat = lstatSync(webDir);
      if (webStat.isSymbolicLink()) continue;
      if (!webStat.isDirectory()) continue;
    } catch {
      // Race condition: directory may have been removed between discovery and read
      continue;
    }

    let webEntries: string[];
    try {
      webEntries = readdirSync(webDir);
    } catch {
      // Race condition: directory may have been removed between stat and read
      continue;
    }

    for (const file of webEntries) {
      if (file.endsWith('Renderer.tsx')) {
        renderers.push(join(webDir, file));
      }
    }
  }

  return renderers;
}

export function externalRenderers(): Plugin {
  return {
    name: 'external-renderers',
    resolveId(id, importer) {
      if (id === 'virtual:engin-renderers') {
        return '\0virtual:engin-renderers';
      }

      // External renderer files live outside the project tree, so bare
      // specifiers (e.g. '@tanstack/react-virtual') won't resolve against
      // the project's node_modules. Re-resolve them from the project root.
      if (id.endsWith('.css')) return null;

      const workflowsPrefix = join(homedir(), '.config', 'engin', 'workflows') + sep;
      if (importer && importer.startsWith(workflowsPrefix) && !id.startsWith('.') && !id.startsWith('/')) {
        return this.resolve(id, projectRoot + '/index.html');
      }
    },
    load(id) {
      if (id === '\0virtual:engin-renderers') {
        const renderers = discoverRenderers();

        // Watch all renderer files (CSS files are discovered transitively via imports)
        for (const rendererPath of renderers) {
          this.addWatchFile(rendererPath);
        }

        if (renderers.length === 0) {
          return '';
        }

        return renderers.map((p) => `import '${p}';`).join('\n');
      }
    },
  };
}
