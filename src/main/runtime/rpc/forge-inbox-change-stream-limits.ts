// Counts change rows sent but not acknowledged, not seq gaps, so sparse seqs cannot stretch the window.
export const FORGE_CHANGE_STREAM_WINDOW = 500

export const FORGE_CHANGE_PAGE_SIZE = 100

// Pages read before yielding, so one catch-up cannot starve the event loop.
export const FORGE_CHANGE_PAGES_PER_TURN = 4
