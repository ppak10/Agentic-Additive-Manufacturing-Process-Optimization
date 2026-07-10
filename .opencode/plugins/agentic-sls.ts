/**
 * agentic-sls plugin for opencode.
 *
 * Mirrors the Claude Code plugin (.claude-plugin/plugin.json):
 *   - Registers the `agentic-sls` MCP server (uv + agentic_sls.mcp)
 *   - Exposes the bundled skills/ directory so opencode discovers SKILL.md files
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface OpencodeConfig {
  mcp?: Record<string, unknown>;
  skills?: { paths?: string[] };
}

interface PluginContext {
  client?: unknown;
  directory?: string;
}

interface PluginHooks {
  config: (config: OpencodeConfig) => Promise<void>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const skillsDirs = [
  path.join(repoRoot, 'skills'),
  path.join(repoRoot, 'plugin', 'skills'),
];

export const AgenticSlsPlugin = async ({ directory }: PluginContext): Promise<PluginHooks> => {
  const projectDir = directory ?? process.cwd();

  return {
    config: async (config) => {
      config.mcp ??= {};

      // Process-control server (TypeScript, plugin/): printer status,
      // recoater passes, layer overrides via the Inova-API-Plugin on :5001.
      config.mcp['agentic-sls'] = {
        type: 'local',
        command: ['node', path.join(repoRoot, 'plugin', 'scripts', 'launch.cjs')],
        enabled: true,
      };

      // Legacy Python server: /api/status polling + chamber camera capture
      // against the firmware's port-80 API.
      config.mcp['agentic-sls-py'] = {
        type: 'local',
        command: ['uv', '--directory', repoRoot, 'run', '-m', 'agentic_sls.mcp'],
        environment: {
          PYTHONPATH: path.join(repoRoot, 'src'),
          AGENTIC_SLS_PROJECT_DIR: projectDir,
        },
      };

      config.skills ??= {};
      config.skills.paths ??= [];
      for (const dir of skillsDirs) {
        if (!config.skills.paths.includes(dir)) {
          config.skills.paths.push(dir);
        }
      }
    },
  };
};
