import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductListQueryDto } from './dto/product-list-query.dto';
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
}
