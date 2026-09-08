import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductListQueryDto,
  ProductSortField,
  SortOrder,
} from './dto/product-list-query.dto';

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: {
    product: {
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      product: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  const query = (
    overrides: Partial<ProductListQueryDto> = {},
  ): ProductListQueryDto => Object.assign(new ProductListQueryDto(), overrides);

  it('restricts a public list to active products', async () => {
    await service.list(query(), 'active-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('applies no isActive filter when visibility is all', async () => {
    await service.list(query(), 'all');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('restricts to inactive products when asked', async () => {
    await service.list(query(), 'inactive-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: false } }),
    );
  });

  it('translates category and price filters into the where clause', async () => {
    await service.list(
      query({
        categoryId: '0195f0a0-0000-7000-8000-000000000000',
        minPriceCents: 1000,
        maxPriceCents: 5000,
      }),
      'active-only',
    );

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          categoryId: '0195f0a0-0000-7000-8000-000000000000',
          priceCents: { gte: 1000, lte: 5000 },
        },
      }),
    );
  });

  it('defaults to newest first', async () => {
    await service.list(query(), 'active-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });

  it('sorts by a whitelisted field in the requested direction', async () => {
    await service.list(
      query({ sort: ProductSortField.PriceCents, order: SortOrder.Asc }),
      'active-only',
    );

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { priceCents: 'asc' } }),
    );
  });

  it('applies pagination and always joins the category', async () => {
    await service.list(query({ page: 3, limit: 10 }), 'active-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 10,
        include: { category: true },
      }),
    );
  });

  it('returns items and total from one transaction', async () => {
    prisma.$transaction.mockResolvedValueOnce([[{ id: 'p1' }], 7]);

    const result = await service.list(query(), 'active-only');

    expect(result).toEqual({ items: [{ id: 'p1' }], total: 7 });
  });

  it('finds one product within the requested visibility', async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: 'p1' });

    const result = await service.findOne('p1', 'active-only');

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', isActive: true },
      include: { category: true },
    });
    expect(result).toEqual({ id: 'p1' });
  });

  it('throws 404 when the product is outside the requested visibility', async () => {
    // An inactive product on the public path must read as absent, not as
    // present-but-hidden. Enforcing this on the list and forgetting it here
    // is the specific defect this design guards against.
    prisma.product.findFirst.mockResolvedValueOnce(null);

    await expect(service.findOne('p1', 'active-only')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deactivates rather than deleting', async () => {
    prisma.product.update.mockResolvedValueOnce({ id: 'p1' });

    await service.deactivate('p1');

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { isActive: false },
    });
  });

  it('creates a product and returns it with its category', async () => {
    prisma.product.create.mockResolvedValueOnce({ id: 'p1' });

    await service.create({
      name: 'Desk Lamp',
      description: 'A lamp',
      priceCents: 4999,
      currency: 'USD',
      categoryId: 'c1',
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Desk Lamp',
        description: 'A lamp',
        priceCents: 4999,
        currency: 'USD',
        categoryId: 'c1',
      },
      include: { category: true },
    });
  });
});
