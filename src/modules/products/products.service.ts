import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductListQueryDto } from './dto/product-list-query.dto';
import { StockRefusal } from './types/stock-refusal';
import {
  ProductVisibility,
  ProductWithCategory,
  visibilityFilter,
} from './types/product-visibility';

export interface CreateProductInput {
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  imageUrl?: string;
  categoryId: string;
  stockQuantity?: number;
}

export interface ProductSnapshot {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  priceCents?: number;
  currency?: string;
  imageUrl?: string | null;
  categoryId?: string;
  isActive?: boolean;
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `visibility` is required, never defaulted. See types/product-visibility.ts.
   */
  async list(
    query: ProductListQueryDto,
    visibility: ProductVisibility,
  ): Promise<{ items: ProductWithCategory[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...visibilityFilter(visibility),
    };

    if (query.categoryId !== undefined) {
      where.categoryId = query.categoryId;
    }

    if (
      query.minPriceCents !== undefined ||
      query.maxPriceCents !== undefined
    ) {
      where.priceCents = {
        ...(query.minPriceCents !== undefined
          ? { gte: query.minPriceCents }
          : {}),
        ...(query.maxPriceCents !== undefined
          ? { lte: query.maxPriceCents }
          : {}),
      };
    }

    // query.sort is a ProductSortField, so this object can only ever name a
    // whitelisted column — the ValidationPipe rejected anything else with a
    // 400 before the request reached this service.
    const orderBy = {
      [query.sort]: query.order,
    } as Prisma.ProductOrderByWithRelationInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        orderBy,
        include: { category: true },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  async findOne(
    id: string,
    visibility: ProductVisibility,
  ): Promise<ProductWithCategory> {
    const product = await this.prisma.product.findFirst({
      where: { id, ...visibilityFilter(visibility) },
      include: { category: true },
    });

    // Outside the requested visibility reads as absent, not as hidden.
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  // An unknown categoryId raises P2003, which HttpExceptionFilter maps to 409.
  // The foreign key is the check; a pre-flight lookup would duplicate a
  // database guarantee and introduce a check-then-act race.
  async create(input: CreateProductInput): Promise<ProductWithCategory> {
    return this.prisma.product.create({
      data: input,
      include: { category: true },
    });
  }

  // P2025 on an unknown id propagates and becomes a 404.
  async update(
    id: string,
    input: UpdateProductInput,
  ): Promise<ProductWithCategory> {
    return this.prisma.product.update({
      where: { id },
      data: input,
      include: { category: true },
    });
  }

  /** Soft delete. The row is never removed — historical orders in Phase 3
   *  must keep valid product references. */
  async deactivate(id: string): Promise<void> {
    await this.prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * Claims `quantity` units. The check and the write are ONE statement: the
   * predicate travels with the write, exactly as RefreshTokenService.rotate()
   * claims a token. Do not "simplify" this into a read, a check, and an
   * update — two concurrent checkouts would both read the same stock, both
   * pass the check, and both write, and the oversell would be invisible.
   *
   * Returns the matched row count. 0 means refused; ask describeRefusal() why.
   * `tx` is required so this can never run outside the checkout transaction.
   */
  async decrementStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantity: number,
  ): Promise<number> {
    const { count } = await tx.product.updateMany({
      where: {
        id: productId,
        isActive: true,
        stockQuantity: { gte: quantity },
      },
      data: { stockQuantity: { decrement: quantity } },
    });

    return count;
  }

  /**
   * Restores stock on cancellation. Deliberately has no isActive predicate:
   * stock must return even to a product deactivated after the order was
   * placed. updateMany, not update, so a vanished product cannot turn a
   * cancellation into a 404.
   */
  async incrementStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantity: number,
  ): Promise<void> {
    await tx.product.updateMany({
      where: { id: productId },
      data: { stockQuantity: { increment: quantity } },
    });
  }

  /**
   * Explains a refusal that already happened. Never authorises a sale, and is
   * never consulted before a decrement (spec §5.3.1).
   *
   * Takes no ProductVisibility: telling an absent product apart from an
   * inactive one is the whole job, so it must see the row either way. This is
   * also why findOne(id, 'all') is NOT used here — findOne throws
   * NotFoundException, which would surface as a misleading 404 on
   * POST /orders, and it queries this.prisma, so it would read outside the
   * caller's transaction.
   */
  async describeRefusal(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<StockRefusal> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { isActive: true },
    });

    if (!product) {
      return 'missing';
    }

    return product.isActive ? 'insufficient-stock' : 'inactive';
  }

  /**
   * Price/name snapshot source for checkout. Called only AFTER the caller
   * holds every one of these product row locks, so no concurrent price
   * update can land between this read and the order insert.
   */
  async findManyForSnapshot(
    tx: Prisma.TransactionClient,
    productIds: string[],
  ): Promise<ProductSnapshot[]> {
    return tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, priceCents: true, currency: true },
    });
  }

  /**
   * Relative restock, never an absolute set: an absolute write is a lost
   * update (an admin reads 10, a checkout commits 10 -> 9, the admin writes
   * 15, and that sale is erased). Same compare-and-swap as decrementStock, so
   * a reduction below zero returns 409 instead of reaching the CHECK
   * constraint.
   */
  async adjustStock(id: string, delta: number): Promise<ProductWithCategory> {
    const { count } = await this.prisma.product.updateMany({
      // For a positive delta this bound is negative and always true.
      where: { id, stockQuantity: { gte: -delta } },
      data: { stockQuantity: { increment: delta } },
    });

    if (count === 0) {
      const exists = await this.prisma.product.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!exists) {
        throw new NotFoundException('Product not found');
      }

      throw new ConflictException('Insufficient stock for this adjustment');
    }

    return this.findOne(id, 'all');
  }
}
