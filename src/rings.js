const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

const near = (actual, target) => Math.abs(actual - target) <= target * 0.05;

export function selectRingWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return [];
  const fiveHours = windows.find((windowData) => near(windowData.seconds, FIVE_HOURS));
  const weekly = windows.find((windowData) => near(windowData.seconds, WEEK));
  const selected = [fiveHours, weekly].filter(Boolean);
  for (const windowData of windows) {
    if (selected.length >= 2) break;
    if (!selected.includes(windowData)) selected.push(windowData);
  }
  return selected;
}

export function ringTone(remainingPercent) {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 30) return "warning";
  return "normal";
}
