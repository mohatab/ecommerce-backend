import { Prisma } from '@prisma/client';

/**
 * Which slice of the catalog a read may see.
 *
 * Every read method takes this as a REQUIRED argument. A default of
 * 'active-only' would be safe but silent; a caller that forgets it should
 * fail to compile, because the failure this guards against — a future phase
 * quietly reading deactivated products into an order — is exactly the kind a
 * default hides. Same rule Phase 1 applied by leaving `role` off
 * CreateUserInput: make the unsafe call unrepresentable.
 */
export type ProductVisibility = 'active-only' | 'all' | 'inactive-only';

/** Products are always returned with their category joined. */
export type ProductWithCategory = Prisma.ProductGetPayload<{
  include: { category: true };
}>;

export function visibilityFilter(visibility: ProductVisibility): {
  isActive?: boolean;
} {
  switch (visibility) {
    case 'active-only':
      return { isActive: true };
    case 'inactive-only':
      return { isActive: false };
    case 'all':
      return {};
  }
}
