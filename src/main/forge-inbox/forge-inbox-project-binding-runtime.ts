import {
  resolveProjectBindingContext,
  type ProjectBindingContext,
  type ProjectBindingContextStore
} from './forge-inbox-project-binding-context'

/** What a host shell must supply: its live store, so no client-supplied path is ever used. */
export type ForgeInboxProjectBindingRuntimeBinding = {
  requireStore: () => ProjectBindingContextStore
}

/** The production resolver behind every background binding reconcile. */
export function forgeInboxProjectBindingContextForRuntime(
  runtime: ForgeInboxProjectBindingRuntimeBinding
): (repoId: string) => ProjectBindingContext {
  return (repoId) => resolveProjectBindingContext(runtime.requireStore(), repoId)
}
