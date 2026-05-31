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
const pluginRoot = path.resolve(__dirname, '../..');
const skillsDir = path.join(pluginRoot, 'skills');

export const AgenticSlsPlugin = async ({ directory }: PluginContext): Promise<PluginHooks> => {
  const projectDir = directory ?? process.cwd();

  return {
    config: async (config) => {
      config.mcp ??= {};
      config.mcp['agentic-sls'] = {
        type: 'local',
        command: ['uv', '--directory', pluginRoot, 'run', '-m', 'agentic_sls.mcp'],
        environment: {
          PYTHONPATH: path.join(pluginRoot, 'src'),
          AGENTIC_SLS_PROJECT_DIR: projectDir,
        },
      };

      config.skills ??= {};
      config.skills.paths ??= [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }
    },
  };
};
