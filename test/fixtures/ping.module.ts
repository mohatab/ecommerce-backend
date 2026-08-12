import { Controller, Get, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class EchoQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit!: number;
}

@Controller('ping')
export class PingController {
  @Get()
  ping(): { pong: true } {
    return { pong: true };
  }

  @Get('echo')
  echo(@Query() query: EchoQueryDto): { limit: number; limitType: string } {
    return { limit: query.limit, limitType: typeof query.limit };
  }
}

@Module({ controllers: [PingController] })
export class PingModule {}
