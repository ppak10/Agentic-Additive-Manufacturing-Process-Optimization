/**
 * Thin root shim: OpenCode resolves the project root via git toplevel (not
 * cwd), so this file must live at the REPO root even though all plugin
 * content lives in services/plugins/ (the harness project root for every
 * other CLI). Registers the same MCP server + skills as
 * services/plugins/.opencode/plugins/agentic-sls.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface OpencodeConfig {
  mcp?: Record<string, unknown>;
  skills?: { paths?: string[] };
}
interface PluginHooks {
  config: (config: OpencodeConfig) => Promise<void>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const pluginsRoot = path.join(repoRoot, 'services', 'plugins');

export const AgenticSlsPlugin = async (): Promise<PluginHooks> => ({
  config: async (config) => {
    config.mcp ??= {};
    config.mcp['agentic-sls'] = {
      type: 'local',
      command: ['node', path.join(pluginsRoot, 'mcp', 'scripts', 'launch-local.cjs')],
      enabled: true,
    };
    config.skills ??= {};
    config.skills.paths ??= [];
    const skillsDir = path.join(pluginsRoot, 'mcp', 'skills');
    if (!config.skills.paths.includes(skillsDir)) {
      config.skills.paths.push(skillsDir);
    }
  },
});
