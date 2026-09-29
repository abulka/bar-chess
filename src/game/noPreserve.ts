import type { MotionData, OrderData } from '../ecs/components'

/**
 * "No-preserve" — the player's insist override.
 *
 * Normally a hurt, outgunned or under-fire piece retreats on its own, even
 * while it is pursuing an order (see the self-preservation pass in the `orders`
 * system). A player can override that for a specific order by holding Alt when
 * the order is given: the order then carries `noPreserveUntil`, an absolute
 * turn index until which the retreat behaviour is suspended. The piece presses
 * the clicked order instead, and any latched healing hold is released.
 *
 * Like the insta-kill flag it lives on the order so it is part of the world
 * snapshot and replays deterministically. It is bounded by both the order's
 * lifetime (replacing, completing or clearing the order ends it) and the fixed
 * turn cap below.
 */

/** Turns of self-preservation suspension an insist order buys. */
export const NO_PRESERVE_TURNS = 2

/**
 * Whether this order currently suspends self-preservation. The window is
 * exclusive of the stored turn: an order issued during the pause after turn P
 * sets `noPreserveUntil` to `P + N + 1`, so it is active on turns `P + 1 … P + N`
 * and preservation resumes on `P + N + 1`.
 */
export function orderInsists(order: OrderData, turn: number): boolean {
  return order.noPreserveUntil >= 0 && turn < order.noPreserveUntil
}

/** Order-history note recorded when an insist order is issued. */
export function noPreserveOrderedNote(turns: number): string {
  return `no-preserve: self-preservation off for ${turns} turns — pressing the order`
}

/** Order-history note recorded when the override stops a retreat this tick. */
export function noPreserveSuppressedNote(until: number): string {
  return `self-preservation suppressed by no-preserve (until turn ${until})`
}

/** Order-history note recorded once the insist window has lapsed. */
export function noPreserveEndedNote(): string {
  return 'no-preserve over — self-preservation restored'
}

/**
 * Arm the insist override on an order: suspend self-preservation until `turn`
 * plus `turns`, and release any latched healing hold so it cannot veto the
 * order. The caller records the order-history note.
 */
export function armNoPreserve(
  order: OrderData,
  motion: MotionData,
  turn: number,
  turns: number = NO_PRESERVE_TURNS,
): void {
  order.noPreserveUntil = turn + turns + 1
  motion.holdUntilHp = 0
}
