import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export interface CreateCategoryInput {
  name: string;
  slug: string;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: PaginationQueryDto,
  ): Promise<{ items: Category[]; total: number }> {
    // One round trip for both halves of the paginated response.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.category.findMany({
        skip: query.skip,
        take: query.limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.category.count(),
    ]);

    return { items, total };
  }

  // P2002 on a duplicate name or slug propagates to HttpExceptionFilter,
  // which maps it to 409. Do not catch it here.
  async create(input: CreateCategoryInput): Promise<Category> {
    return this.prisma.category.create({ data: input });
  }

  // P2025 on an unknown id propagates and becomes a 404.
  async update(id: string, input: UpdateCategoryInput): Promise<Category> {
    return this.prisma.category.update({ where: { id }, data: input });
  }
}
