// Conservative subject aliases plus explicitly approved tags. No model, private data or
// inferred expertise. A subject connection never establishes willingness to help.
import type { Signal } from "./signals.js";
import { normalizeEntityKey } from "./signals.js";

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "voice AI": ["voice ai", "speech recognition", "speech ai", "speech technology"],
  "machine learning": ["machine learning", "ml"],
  "healthcare": ["healthcare", "health care", "healthtech", "health tech"],
  "React": ["react", "reactjs", "react js"],
  "user experience": ["user experience", "ux", "ux design"],
  "climate technology": ["climate tech", "climate technology", "cleantech", "clean tech"],
};

const SUBJECT_TYPES = new Set(["working_on", "looking_for", "can_help_with", "interested_in", "experienced_in"]);

export function concepts(signal: Signal): Map<string, string> {
  const out = new Map<string, string>([[signal.entity.key, signal.entity.label]]);
  if (!SUBJECT_TYPES.has(signal.type) || signal.entity.kind === "event" || signal.entity.kind === "company") return out;
  for (const label of [signal.entity.label, ...(signal.topics ?? [])]) {
    const key = normalizeEntityKey("topic", label);
    if (label !== signal.entity.label) out.set(key, label);
    const words = ` ${key} `;
    for (const [canonical, aliases] of Object.entries(ALIASES)) {
      if (aliases.some((alias) => words.includes(` ${alias} `))) {
        out.set(normalizeEntityKey("topic", canonical), canonical);
      }
    }
  }
  return out;
}

/** An exact entity or a conservatively aligned subject, without disclosing one-sided labels. */
export function commonSubject(a: Signal, b: Signal): { key: string; label: string } | null {
  if (a.entity.key === b.entity.key && a.entity.kind === b.entity.kind) return { key: a.entity.key, label: a.entity.label };
  if (!SUBJECT_TYPES.has(a.type) || !SUBJECT_TYPES.has(b.type)) return null;
  if ([a.entity.kind, b.entity.kind].some((kind) => kind === "event" || kind === "company" || kind === "course")) return null;
  const theirs = concepts(b);
  for (const [key, label] of concepts(a)) if (theirs.has(key)) return { key, label };
  return null;
}
