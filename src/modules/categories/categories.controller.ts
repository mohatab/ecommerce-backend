import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { CategoryResponseDto } from './dto/category-response.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List catalog categories' })
  @ApiPaginatedResponse(CategoryResponseDto)
  async list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedDto<CategoryResponseDto>> {
    const { items, total } = await this.categoriesService.list(query);

    return PaginatedDto.from(
      items.map((item) => CategoryResponseDto.from(item)),
      total,
      query,
    );
  }
}
