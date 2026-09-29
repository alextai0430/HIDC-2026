export const technicalLevels = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function stepTechnicalLevel(current: number, direction: -1 | 1) {
  const currentIndex = technicalLevels.indexOf(current as (typeof technicalLevels)[number]);
  if (currentIndex < 0) return current;
  return technicalLevels[Math.max(0, Math.min(technicalLevels.length - 1, currentIndex + direction))];
}

export function matchHotkeyAction(
  hotkeys: Record<string, string>,
  sequence: string,
  key: string,
) {
  return Object.keys(hotkeys).find((action) => hotkeys[action] === sequence) ??
    Object.keys(hotkeys).find((action) => hotkeys[action] === key);
}
