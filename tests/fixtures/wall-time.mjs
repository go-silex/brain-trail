// Date.now is wall time; the SDK mock clock advances only SDK clock hooks.
export const waitWallTime = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms))
