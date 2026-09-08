import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: {
    category: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      category: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  const query = (page = 1, limit = 20): PaginationQueryDto => {
    const dto = new PaginationQueryDto();

    dto.page = page;
    dto.limit = limit;

    return dto;
  };

  it('lists categories ordered by name with pagination applied', async () => {
    prisma.$transaction.mockResolvedValueOnce([[{ id: 'c1' }], 1]);

    const result = await service.list(query(2, 10));

    expect(prisma.category.findMany).toHaveBeenCalledWith({
      skip: 10,
      take: 10,
      orderBy: { name: 'asc' },
    });
    expect(result).toEqual({ items: [{ id: 'c1' }], total: 1 });
  });

  it('creates a category with the supplied name and slug', async () => {
    prisma.category.create.mockResolvedValueOnce({ id: 'c1' });

    await service.create({ name: 'Desks', slug: 'desks' });

    expect(prisma.category.create).toHaveBeenCalledWith({
      data: { name: 'Desks', slug: 'desks' },
    });
  });

  it('updates only the supplied fields', async () => {
    prisma.category.update.mockResolvedValueOnce({ id: 'c1' });

    await service.update('c1', { name: 'Standing Desks' });

    expect(prisma.category.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Standing Desks' },
    });
  });

  it('does not translate Prisma errors itself', async () => {
    // P2002 on a duplicate name/slug must travel to HttpExceptionFilter,
    // which already maps it to 409. Catching and re-throwing here would
    // translate the same error twice, in two places, with two messages.
    const failure = new Error('P2002');

    prisma.category.create.mockRejectedValueOnce(failure);

    await expect(service.create({ name: 'Desks', slug: 'desks' })).rejects.toBe(
      failure,
    );
  });
});
