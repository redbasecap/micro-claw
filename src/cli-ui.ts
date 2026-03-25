import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import type { Writable } from "node:stream";

type Rgb = readonly [number, number, number];

export type CliTone = "accent" | "secondary" | "success" | "warning" | "danger" | "muted" | "strong";

export interface CliRow {
  label: string;
  value: string;
  tone?: CliTone;
}

interface TerminalWritable extends Writable {
  isTTY?: boolean;
  columns?: number;
}

const MICRO_LINES = [
  " __  __ ___ ____ ____   ___ ",
  "|  \\/  |_ _/ ___|  _ \\ / _ \\",
  "| |\\/| || | |   | |_) | | | |",
  "| |  | || | |___|  _ <| |_| |",
  "|_|  |_|___\\____|_| \\_\\\\___/"
] as const;

const CLAW_LINES = [
  "  ____ _        ___ __        __",
  " / ___| |      / _ \\\\ \\      / /",
  "| |   | |     | | | |\\ \\ /\\ / / ",
  "| |___| |___  | |_| | \\ V  V /  ",
  " \\____|_____|  \\___/   \\_/\\_/   "
] as const;

const BANNER_PALETTE: readonly Rgb[] = [
  [56, 189, 248],
  [45, 212, 191],
  [251, 146, 60]
] as const;

const SPINNER_FRAMES = [
  "[=     ]",
  "[==    ]",
  "[ ===  ]",
  "[  === ]",
  "[   ===]",
  "[    ==]",
  "[     =]",
  "[    ==]"
] as const;

function isTerminalWritable(output?: Writable): output is TerminalWritable {
  return Boolean(output && (output as TerminalWritable).isTTY);
}

function supportsColor(output?: Writable, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isTerminalWritable(output)) {
    return false;
  }

  if (env.NO_COLOR !== undefined || env.TERM === "dumb") {
    return false;
  }

  return true;
}

function supportsMotion(output?: Writable, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!supportsColor(output, env)) {
    return false;
  }

  if (env.CI || env.MICRO_CLAW_NO_ANIMATION === "1") {
    return false;
  }

  return true;
}

function paintRgb(enabled: boolean, rgb: Rgb, text: string, options?: { bold?: boolean; dim?: boolean }): string {
  if (!enabled || text.length === 0) {
    return text;
  }

  const modes = [
    options?.bold ? "1" : "",
    options?.dim ? "2" : "",
    `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`
  ].filter(Boolean);

  return `\x1b[${modes.join(";")}m${text}\x1b[0m`;
}

function paintStyle(enabled: boolean, code: string, text: string): string {
  if (!enabled || text.length === 0) {
    return text;
  }

  return `\x1b[${code}m${text}\x1b[0m`;
}

function gradientText(enabled: boolean, text: string, palette: readonly Rgb[]): string {
  if (!enabled || text.length === 0) {
    return text;
  }

  const visibleChars = [...text].filter((char) => char !== " ").length;
  if (visibleChars <= 1) {
    return paintRgb(enabled, palette[0], text, { bold: true });
  }

  let seen = 0;

  return [...text]
    .map((char) => {
      if (char === " ") {
        return char;
      }

      const ratio = seen / Math.max(visibleChars - 1, 1);
      const index = Math.min(palette.length - 1, Math.round(ratio * (palette.length - 1)));
      seen += 1;
      return paintRgb(enabled, palette[index], char, { bold: true });
    })
    .join("");
}

function visibleWidth(output?: Writable): number {
  if (isTerminalWritable(output) && typeof output.columns === "number") {
    return output.columns;
  }

  return 80;
}

function buildRule(width: number): string {
  return "-".repeat(Math.max(28, Math.min(width - 2, 72)));
}

function toneRgb(tone: CliTone): Rgb {
  switch (tone) {
    case "secondary":
      return [45, 212, 191];
    case "success":
      return [74, 222, 128];
    case "warning":
      return [251, 191, 36];
    case "danger":
      return [248, 113, 113];
    case "muted":
      return [148, 163, 184];
    case "strong":
      return [226, 232, 240];
    case "accent":
    default:
      return [56, 189, 248];
  }
}

function formatLabelValueRows(
  rows: CliRow[],
  paint: (tone: CliTone, text: string) => string,
  dim: (text: string) => string
): string {
  const width = rows.reduce((max, row) => Math.max(max, row.label.length), 0);

  return rows
    .map((row) => `${dim(row.label.padEnd(width))}  ${paint(row.tone ?? "strong", row.value)}`)
    .join("\n");
}

export interface CliUi {
  decorated: boolean;
  motion: boolean;
  width: number;
  accent: (text: string) => string;
  secondary: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  danger: (text: string) => string;
  muted: (text: string) => string;
  strong: (text: string) => string;
  gradient: (text: string) => string;
  section: (title: string) => string;
  renderRows: (rows: CliRow[]) => string;
  renderList: (items: string[], tone?: CliTone) => string;
  renderHero: (subtitle?: string) => string;
  renderCommandHeader: (title: string, subtitle?: string) => string;
  formatProgress: (message: string) => string;
  formatAgent: (message: string, tone?: CliTone) => string;
  prompt: (label: string) => string;
}

export function createCliUi(output?: Writable, env: NodeJS.ProcessEnv = process.env): CliUi {
  const decorated = supportsColor(output, env);
  const motion = supportsMotion(output, env);
  const width = visibleWidth(output);
  const paint = (tone: CliTone, text: string) => paintRgb(decorated, toneRgb(tone), text, { bold: tone !== "muted" });
  const dim = (text: string) => paintRgb(decorated, toneRgb("muted"), text, { dim: true });

  return {
    decorated,
    motion,
    width,
    accent(text: string): string {
      return paint("accent", text);
    },
    secondary(text: string): string {
      return paint("secondary", text);
    },
    success(text: string): string {
      return paint("success", text);
    },
    warning(text: string): string {
      return paint("warning", text);
    },
    danger(text: string): string {
      return paint("danger", text);
    },
    muted(text: string): string {
      return dim(text);
    },
    strong(text: string): string {
      return paintStyle(decorated, "1", text);
    },
    gradient(text: string): string {
      return gradientText(decorated, text, BANNER_PALETTE);
    },
    section(title: string): string {
      return `${paint("accent", title.toUpperCase())}\n${dim(buildRule(width))}`;
    },
    renderRows(rows: CliRow[]): string {
      return formatLabelValueRows(rows, paint, dim);
    },
    renderList(items: string[], tone: CliTone = "strong"): string {
      if (items.length === 0) {
        return paint("muted", "- none");
      }

      return items.map((item) => `${dim("-")} ${paint(tone, item)}`).join("\n");
    },
    renderHero(subtitle = "MICRO CLAW // repo agent for the terminal"): string {
      const lines = MICRO_LINES.map((line, index) => {
        const claw = CLAW_LINES[index];
        return `${gradientText(decorated, line, BANNER_PALETTE)}  ${gradientText(decorated, claw, [...BANNER_PALETTE].reverse())}`;
      });

      return [...lines, "", paint("secondary", subtitle), dim(buildRule(width))].join("\n");
    },
    renderCommandHeader(title: string, subtitle?: string): string {
      return [
        `${gradientText(decorated, "MICRO CLAW", BANNER_PALETTE)} ${dim("//")} ${paint("strong", title.toUpperCase())}`,
        subtitle ? dim(subtitle) : undefined,
        dim(buildRule(width))
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    },
    formatProgress(message: string): string {
      if (!decorated) {
        return `progress> ${message}`;
      }

      return `${paint("accent", "progress")} ${dim(">")} ${paint("strong", message)}`;
    },
    formatAgent(message: string, tone: CliTone = "accent"): string {
      if (!decorated) {
        return `agent> ${message}`;
      }

      return `${paint("secondary", "agent")} ${dim(">")} ${paint(tone, message)}`;
    },
    prompt(label: string): string {
      if (!decorated) {
        return `${label}> `;
      }

      return `${gradientText(decorated, label, BANNER_PALETTE)} ${dim(">")} `;
    }
  };
}

export async function writeHero(
  output?: Writable,
  options?: {
    subtitle?: string;
    animate?: boolean;
    env?: NodeJS.ProcessEnv;
  }
): Promise<void> {
  if (!output) {
    return;
  }

  const ui = createCliUi(output, options?.env);
  const hero = ui.renderHero(options?.subtitle);
  const lines = hero.split("\n");

  if (!options?.animate || !ui.motion) {
    output.write(`${hero}\n`);
    return;
  }

  for (const line of lines) {
    output.write(`${line}\n`);
    await delay(26);
  }
}

export async function runWithSpinner<T>(
  output: Writable | undefined,
  label: string,
  task: () => Promise<T>,
  options?: {
    env?: NodeJS.ProcessEnv;
  }
): Promise<T> {
  const ui = createCliUi(output, options?.env);
  if (!output || !ui.motion) {
    return task();
  }

  let frame = 0;
  let active = true;
  output.write("\x1b[?25l");

  const render = () => {
    if (!active) {
      return;
    }

    const current = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame += 1;
    output.write(`\r\x1b[2K${ui.accent(current)} ${ui.muted(label)}`);
  };

  render();
  const timer = setInterval(render, 90);

  try {
    const result = await task();
    active = false;
    clearInterval(timer);
    output.write(`\r\x1b[2K${ui.success("[done]")} ${ui.strong(label)}\n`);
    return result;
  } catch (error) {
    active = false;
    clearInterval(timer);
    output.write(`\r\x1b[2K${ui.danger("[fail]")} ${ui.strong(label)}\n`);
    throw error;
  } finally {
    output.write("\x1b[?25h");
  }
}
