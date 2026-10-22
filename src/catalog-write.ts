/**
 * Writing the model's saved directory back to the Host's settings document.
 *
 * THE HOST-SIDE HALF OF ISSUES #114/#115. The card's own save path lives in
 * the browser half (`src/client/`), but the repair that heals a STALE saved
 * directory has to happen where the LIVE roster lands — inside the Host
 * process, right after the upstream answered. So this module writes through
 * the Host's own settings service, using the same merge discipline the
 * browser half uses (see `src/web-status.ts`).
 *
 * WHY NOT JUST WRITE THE WHOLE `regions` FIELD. Because the field holds
 * BOTH regions plus each region's account-pool preferences, and a blind write
 * would drop whatever the user changed in the other region (issue #32's
 * lesson, in a new place). So the write is a MERGE: the region's slot is
 * replaced, every other key of the slot is preserved, and the sibling region
 * is untouched.
 *
 * WHY THE HOST SERVICE RATHER THAN THE SCOPE. The plugin's browser half
 * writes through the Host's settings endpoint because the browser-side
 * `scope.set()` replaces the whole field with the browser's own (possibly
 * stale) mirror — that is documented at `src/client/account-selection.ts`.
 * The same reasoning applies here: there is no browser mirror in the Host
 * process, so the Host's own merge is the only safe writer.
 *
 * @module dsh-connect-workbuddy/catalog-write
 */

import { unwrapVolatileDeep } from './status-paths.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * The shape this module needs from the Host's settings service.
 *
 * Narrow on purpose: `describe()` returns the resolved config per namespace
 * (with volatile fields as live references), and `mutate()` applies one
 * operation to a field path. Both are the same calls `src/web-status.ts`
 * makes for the card's save.
 */
export interface HostSettingsService {
  describe(): readonly { ns: string; value?: unknown }[]
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expectedRevision?: number): Promise<void>
}

/**
 * Merge one region's repaired directory into the `regions` field, preserving
 * every other key of that region's slot and the whole sibling region.
 *
 * The merge is done on the AUTHORITATIVE value the settings service holds —
 * not on a snapshot the caller brought — because a snapshot can be stale and
 * a stale merge is how the other region disappears.
 */
export function mergeRegionCatalog(
  current: unknown,
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelInfo[],
): Record<string, unknown> {
  const field = (unwrapVolatileDeep(current) ?? {}) as Record<string, unknown>
  const regions = (field['regions'] ?? {}) as Record<string, unknown>
  const slot = (regions[region] ?? {}) as Record<string, unknown>
  return {
    ...field,
    regions: {
      ...regions,
      [region]: { ...slot, lastCatalog: catalog },
    },
  }
}

/**
 * Write one region's repaired directory.
 *
 * @param service The Host's settings service.
 * @param ns The namespace the Host serves this plugin under.
 * @param region The region whose slot is repaired.
 * @param catalog The repaired directory.
 * @returns whether the write happened.
 */
export async function writeRegionCatalog(
  service: HostSettingsService | undefined,
  ns: string,
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelInfo[],
): Promise<boolean> {
  if (service === undefined) return false
  const row = service.describe().find(entry => entry.ns === ns)
  if (row === undefined) return false
  const current = unwrapVolatileDeep(row.value ?? {}) as Record<string, unknown>
  const next = mergeRegionCatalog(current, region, catalog)
  await service.mutate(ns, [{ op: 'set', path: ['regions'], value: next }], undefined)
  return true
}
