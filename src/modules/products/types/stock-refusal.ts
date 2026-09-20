/**
 * Why a conditional stock decrement matched zero rows (spec §5.3.1).
 *
 * 'missing' and 'inactive' share ONE client-facing message; the distinction
 * exists for logs and tests. 'missing' is unreachable while CartItem's
 * product FK is onDelete: Restrict and products are only soft-deleted, so
 * seeing it means an invariant broke elsewhere.
 */
export type StockRefusal = 'missing' | 'inactive' | 'insufficient-stock';
