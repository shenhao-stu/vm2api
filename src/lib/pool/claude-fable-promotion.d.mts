/** Browser build types for the shared, side-effect-free promotion policy. */
export const FABLE_PRO_START: number
export const FABLE_PRO_END: number
export function proFablePromotionAllows(model: unknown, now?: number): boolean
