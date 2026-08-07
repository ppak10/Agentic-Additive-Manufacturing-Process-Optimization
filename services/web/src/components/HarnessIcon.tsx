// Brand icons for the four agent harnesses, inlined from
// @lobehub/icons-static-svg (24×24, fill=currentColor) so they need no
// dependency and inherit text color. Keyed by the harness ids the broker
// speaks ("claude" | "opencode" | "codex" | "agy").

const PATHS: Record<string, { title: string; d: string; clipRule?: "evenodd" }> = {
  claude: {
    title: "Claude Code",
    d: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
  },
  opencode: {
    title: "opencode",
    d: "M16 6H8v12h8V6zm4 16H4V2h16v20z",
  },
  codex: {
    title: "Codex",
    clipRule: "evenodd",
    d: "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
  },
  agy: {
    title: "Antigravity",
    d: "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z",
  },
};

// Operator-facing display names for the dropdown.
export const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  opencode: "opencode",
  codex: "Codex",
  agy: "Antigravity",
};

// Per-harness model catalog for the composer's model picker. Ids are passed
// verbatim as the CLI's --model. Only harnesses with VERIFIED ids get a list
// (claude: Anthropic ids; opencode: `opencode models` zen catalog as of
// 2026-07-27) — codex/agy show Default + whatever the stream reported until
// their ids are confirmed. An empty selection = the harness's own default.
export const HARNESS_MODELS: Record<string, { id: string; label: string }[]> = {
  claude: [
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  opencode: [
    { id: "opencode/big-pickle", label: "big-pickle" },
    { id: "opencode/deepseek-v4-flash-free", label: "deepseek-v4-flash" },
    { id: "opencode/hy3-free", label: "hy3" },
    { id: "opencode/mimo-v2.5-free", label: "mimo-v2.5" },
    { id: "opencode/nemotron-3-ultra-free", label: "nemotron-3-ultra" },
    { id: "opencode/north-mini-code-free", label: "north-mini-code" },
  ],
  codex: [],
  agy: [],
};

// Short display label for a model id — catalog label when known, else the id
// with common prefixes trimmed.
export function modelLabel(harness: string, id: string | null | undefined): string {
  if (!id) return "Default";
  const hit = HARNESS_MODELS[harness]?.find((m) => m.id === id);
  return hit?.label ?? id.replace(/^(opencode|anthropic|openai|google)\//, "");
}

export function HarnessIcon({
  harness,
  className,
}: {
  harness: string;
  className?: string;
}) {
  const icon = PATHS[harness];
  if (!icon) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className ?? "size-3.5"}
      aria-label={icon.title}
    >
      <path d={icon.d} clipRule={icon.clipRule} />
    </svg>
  );
}
