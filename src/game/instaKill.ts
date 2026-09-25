import type { OrderData } from '../ecs/components'
import type { Entity } from '../ecs/world'

/**
 * "Insta-kill" — the immediate chess kill.
 *
 * When a human player orders an attack (or a move onto an enemy's square) while
 * the `chessKills` rule is on and the victim already sits inside the ordered
 * piece's capture pattern, the victim is parked on `Order.chessKill`. The
 * `orders` system consumes it on the next tick and applies the kill as direct
 * lethal damage. Its defining properties:
 *
 * - **immediate** — one tick, no projectile, no chase;
 * - **highest priority** — it overrides self-preservation for that tick, so a
 *   badly wounded piece still presses it (a deliberate suicide kill is allowed);
 * - **human-only** — only a commanded (human-controlled) piece can issue one,
 *   because AI never issues orders;
 * - **active-order-only** — a queued attack step never carries one; the kill is
 *   only parked when the click starts/replaces the active order.
 *
 * Keep this strictly apart from a **standing attack order** (`Order.kind ===
 * 'attack'` with no parked victim): that chases the target over several moves
 * and yields to self-preservation (retreat while danger is current, safe-hold
 * when badly wounded, resume when safe/healed). Anywhere preserve priority is
 * decided, branch on `hasInstaKill`, never on the attack kind alone.
 */

/** Player-facing name for the concept, shared by the panel, order history and docs. */
export const INSTA_KILL_NAME = 'immediate chess kill'

/** Whether this order currently carries an unconsumed insta-kill victim. */
export function hasInstaKill(order: OrderData): order is OrderData & { chessKill: Entity } {
  return order.chessKill !== null
}

/** Order-history note when the insta-kill is parked at order-issue time. */
export function instaKillOrderedNote(coord: string): string {
  return `${INSTA_KILL_NAME} → ${coord}`
}

/** Order-history note when the parked insta-kill is consumed (strikes). */
export function instaKillLandedNote(coord: string): string {
  return `${INSTA_KILL_NAME} lands → ${coord}`
}
