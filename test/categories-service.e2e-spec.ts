import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { PaginationQueryDto } from '../src/common/dto/pagination-query.dto';
import { truncateAll } from './helpers/truncate';
import { createCategory } from './factories/category.factory';

describe('CategoriesService (e2e)', () => {
  let prisma: PrismaService;
  let service: CategoriesService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new CategoriesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const query = (page = 1, limit = 20): PaginationQueryDto => {
    const dto = new PaginationQueryDto();

    dto.page = page;
    dto.limit = limit;

    return dto;
  };

  it('creates a category that is readable back by id', async () => {
    const created = await service.create({ name: 'Desks', slug: 'desks' });

    const found = await prisma.category.findUnique({
      where: { id: created.id },
    });

    expect(found).not.toBeNull();
    expect(found?.name).toBe('Desks');
    expect(found?.slug).toBe('desks');
  });

  it('rejects a duplicate name with P2002', async () => {
    await createCategory(prisma, { name: 'Desks', slug: 'desks' });

    await expect(
      service.create({ name: 'Desks', slug: 'other-slug' }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    try {
      await service.create({ name: 'Desks', slug: 'another-slug' });
      throw new Error('expected service.create to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(
        'P2002',
      );
    }
  });

  it('rejects a duplicate slug with P2002', async () => {
    await createCategory(prisma, { name: 'Desks', slug: 'desks' });

    try {
      await service.create({ name: 'Other Name', slug: 'desks' });
      throw new Error('expected service.create to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(
        'P2002',
      );
    }
  });

  it('rejects update on an unknown id with P2025', async () => {
    try {
      await service.update('00000000-0000-0000-0000-000000000000', {
        name: 'Nope',
      });
      throw new Error('expected service.update to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(
        'P2025',
      );
    }
  });

  it('updates only the supplied field, leaving the other intact', async () => {
    const category = await createCategory(prisma, {
      name: 'Desks',
      slug: 'desks',
    });

    const updated = await service.update(category.id, {
      name: 'Standing Desks',
    });

    expect(updated.name).toBe('Standing Desks');
    expect(updated.slug).toBe('desks');
  });

  it('lists rows ordered by name ascending, paginated, with a total across all rows', async () => {
    await createCategory(prisma, { name: 'Zebra', slug: 'zebra' });
    await createCategory(prisma, { name: 'Apple', slug: 'apple' });
    await createCategory(prisma, { name: 'Mango', slug: 'mango' });
    await createCategory(prisma, { name: 'Banana', slug: 'banana' });

    const page1 = await service.list(query(1, 2));
    expect(page1.items.map((c) => c.name)).toEqual(['Apple', 'Banana']);
    expect(page1.total).toBe(4);

    const page2 = await service.list(query(2, 2));
    expect(page2.items.map((c) => c.name)).toEqual(['Mango', 'Zebra']);
    expect(page2.total).toBe(4);
  });
});
