import { DETECT_WINDOW, SMART_TRUNCATE_MIN_LINES } from "./constants.js";
import { gitDiff } from "./filters/gitDiff.js";
import { gitStatus } from "./filters/gitStatus.js";
import { grep } from "./filters/grep.js";
import { find } from "./filters/find.js";
import { ls } from "./filters/ls.js";
import { dedupLog } from "./filters/dedupLog.js";
import { smartTruncate } from "./filters/smartTruncate.js";

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;

export function autoDetectFilter(text) {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;
  const lines = head.split("\n");
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  const first5 = nonEmpty.slice(0, 5);
  if (first5.some(isGrepLine)) return grep;
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return ls;
  if (nonEmpty.length >= 5) return dedupLog;
  if (text.split("\n").length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;
  return null;
}

function isGrepLine(line) {
  const first = line.indexOf(":");
  if (first === -1) return false;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return false;
  return /^\d+$/.test(line.slice(first + 1, second));
}

function isPathLike(line) {
  const t = line.trim();
  if (!t || t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}

function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) || []).length;
}
