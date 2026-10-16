export const navigationOrderKey = 'jindu:navigation-order:v1';
export function normalizeNavigationOrder(value: unknown, available: readonly string[]): string[] {
  const saved = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && available.includes(id)) : [];
  return [...new Set([...saved, ...available])];
}
export function moveNavigationItem(order: readonly string[], from: string, to: string): string[] {
  if (from === to || !order.includes(from) || !order.includes(to)) return [...order];
  const result = order.filter(id => id !== from);
  result.splice(order.indexOf(to), 0, from);
  return result;
}
