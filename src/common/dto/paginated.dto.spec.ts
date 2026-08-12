import { PaginatedDto } from './paginated.dto';
import { PaginationQueryDto } from './pagination-query.dto';

describe('PaginatedDto', () => {
  const query = Object.assign(new PaginationQueryDto(), { page: 2, limit: 20 });

  it('wraps data with pagination metadata', () => {
    const result = PaginatedDto.from([{ id: 'a' }], 137, query);

    expect(result.data).toEqual([{ id: 'a' }]);
    expect(result.meta).toEqual({
      page: 2,
      limit: 20,
      total: 137,
      totalPages: 7,
    });
  });

  it('rounds partial pages up', () => {
    const result = PaginatedDto.from([], 21, query);

    expect(result.meta.totalPages).toBe(2);
  });

  it('reports zero pages for an empty result set', () => {
    const result = PaginatedDto.from([], 0, query);

    expect(result.meta.totalPages).toBe(0);
    expect(result.data).toEqual([]);
  });
});
