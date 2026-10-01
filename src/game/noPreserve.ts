import type { MotionData, OrderData } from '../ecs/components'

/**
 * "No-preserve" — the player's insist override.
 *
 * Normally a hurt, outgunned or under-fire piece retreats on its own, even
 * while it is pursuing an order (see the self-preservation pass in the `orders`
 * system). A player can override that for a specific order by holding Alt when
 * the order is given: the order then carries `noPreserve`, and the retreat
 * behaviour is suspended while that order runs. The piece presses the clicked
 * objective instead, and any latched healing hold is released.
 *
 * The suspension lasts as long as the order it was given on is unfinished: a
 * goto until the piece arrives, an attack until the ordered victim dies. It ends
 * when the order completes, is replaced, is promoted from the queue, or is
 * cleared — so a force-ordered move that takes several turns stays committed
 * until it lands, and a force-ordered attack stays committed until its target is
 * destroyed (then preservation returns, even if the piece re-engages a nearby
 * enemy). A queued step carries its own flag, so a plan can mix suspension and
 * ordinary steps. Like the insta-kill flag it lives on the order so it is part of
 * the world snapshot and replays deterministically.
 */

/** Whether this order currently suspends self-preservation. */
export function orderInsists(order: OrderData): boolean {
  return order.noPreserve
}

/** Order-history note recorded when an insist order is issued. */
export function noPreserveOrderedNote(): string {
  return 'no-preserve: pressing the order — self-preservation off until it completes'
}

/** Order-history note recorded when the override stops a retreat this tick. */
export function noPreserveSuppressedNote(): string {
  return 'self-preservation suppressed by no-preserve — pressing the order'
}

/**
 * Arm the insist override on an order: suspend self-preservation while it runs,
 * and release any latched healing hold so it cannot veto the order. The caller
 * records the order-history note.
 */
export function armNoPreserve(order: OrderData, motion: MotionData): void {
  order.noPreserve = true
  motion.holdUntilHp = 0
}
