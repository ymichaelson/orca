/** Sorted-key JSON so equal facts serialize equally regardless of key order; arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => (element === undefined ? 'null' : canonicalJson(element))).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`cannot canonicalize a ${typeof value} value`)
  }
  return JSON.stringify(value)
}
