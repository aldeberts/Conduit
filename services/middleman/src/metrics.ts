export const metrics = {
  wsConnections: 0,
  documentOpens: 0,
  documentSaves: 0,
  yjsUpdatesApplied: 0,
  persistWrites: 0,
};

export function metricsSnapshot(): typeof metrics {
  return { ...metrics };
}
