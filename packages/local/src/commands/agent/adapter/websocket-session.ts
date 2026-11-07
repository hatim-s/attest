import { startWebSocketAgent } from '@attest/executor';

/** Acquires native session ownership in the caller's run scope. */
const startWebSocketSession = (...args: Parameters<typeof startWebSocketAgent>) =>
  startWebSocketAgent(...args);

export { startWebSocketSession };
