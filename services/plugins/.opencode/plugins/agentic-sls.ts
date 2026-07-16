/**
 * agentic-sls plugin for opencode.
 *
 * Registers the `agentic-sls` MCP server (TypeScript, plugin/) and exposes
 * the plugin's skills/ directory so opencode discovers SKILL.md files.
 * (The legacy May-era Python MCP and its root skills/ were retired
 * 2026-07-15.)
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
  path.join(repoRoot, 'mcp', 'skills'),
];

export const AgenticSlsPlugin = async (_ctx: PluginContext): Promise<PluginHooks> => {
  return {
    config: async (config) => {
      config.mcp ??= {};

      // Process-control server (TypeScript, plugin/): printer status,
      // recoater passes, layer overrides via the Inova-API-Plugin on :5001.
      config.mcp['agentic-sls'] = {
        type: 'local',
        command: ['node', path.join(repoRoot, 'mcp', 'scripts', 'launch-local.cjs')],
        enabled: true,
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
