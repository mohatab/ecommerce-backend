import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

function transform(query: Record<string, unknown>): PaginationQueryDto {
  return plainToInstance(PaginationQueryDto, query, {
    enableImplicitConversion: false,
  });
}

describe('PaginationQueryDto', () => {
  it('applies defaults when nothing is supplied', () => {
    const dto = transform({});

    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('converts numeric strings to numbers', () => {
    const dto = transform({ page: '3', limit: '50' });

    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
    expect(typeof dto.page).toBe('number');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects a non-numeric page', () => {
    expect(validateSync(transform({ page: 'abc' }))).not.toHaveLength(0);
  });

  it('rejects a page below 1', () => {
    expect(validateSync(transform({ page: '0' }))).not.toHaveLength(0);
  });

  it('rejects a limit above 100', () => {
    expect(validateSync(transform({ limit: '101' }))).not.toHaveLength(0);
  });

  it('rejects a fractional limit', () => {
    expect(validateSync(transform({ limit: '2.5' }))).not.toHaveLength(0);
  });

  it('computes skip from page and limit', () => {
    expect(transform({}).skip).toBe(0);
    expect(transform({ page: '3', limit: '20' }).skip).toBe(40);
  });
});
