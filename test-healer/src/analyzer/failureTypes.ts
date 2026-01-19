export const failureTypes = {
  MISSING_SELECTOR: 'missing_selector',
  TIMEOUT: 'timeout',
  TEXT_MISMATCH: 'text_mismatch',
  VISIBILITY: 'visibility_state',
  UNKNOWN: 'unknown',
} as const;

export default failureTypes;