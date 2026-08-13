export {
  createBaseEnvironment,
  readSecretReference,
  resolveNativeAgent,
} from './resolve-native-agent.js';
export {
  CONNECTION_TEST_RUN_ID,
  REDACTED,
  assertSupportedProbePolicy,
  redactProbeValue,
  testNativeAgentConnection,
} from './test-native-agent.js';
export { type NativeAgentTestOptions, type ResolvedNativeAgent } from './types.js';
