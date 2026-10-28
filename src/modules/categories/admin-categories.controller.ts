import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Admin-only through ONE class-level decorator, exactly as
 * AdminProductsController is: the likeliest authorization defect here is a
 * write route that forgets @Roles(), and a class-level decorator turns several
 * chances to forget into one.
 *
 * This route exists to close a recorded gap, not to round out a CRUD surface:
 * `Product.categoryId` is required, so before it shipped a fresh database
 * could never accept a product through the API. PATCH and DELETE are
 * deliberately absent — category deletion still needs the orphan policy
 * Phase 2 declined to invent, and `onDelete: Restrict` is unchanged.
 */
@ApiTags('admin-categories')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({ status: 409, description: 'name or slug already exists' })
  async create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    // Fields passed explicitly, never a spread of `dto`: an added DTO field
    // cannot then reach the service unreviewed. No try/catch — P2002 on a
    // duplicate name or slug must propagate to HttpExceptionFilter, which is
    // the one place Prisma errors are mapped.
    return CategoryResponseDto.from(
      await this.categoriesService.create({ name: dto.name, slug: dto.slug }),
    );
  }
}
