/** Name or code only, never the message: messages can carry payload or path content. */
export function forgeErrorLabel(error: unknown): string {
  if (error instanceof Error) {
    return 'code' in error && typeof error.code === 'string' ? error.code : error.name
  }
  return 'unknown'
}
