import { Controller, Module, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../src/common/decorators/public.decorator';

interface RawBodyProbeResult {
  isBuffer: boolean;
  raw: string | null;
  parsedIsObject: boolean;
}

@Controller('raw-body-probe')
class RawBodyProbeController {
  @Public()
  @Post()
  probe(@Req() request: RawBodyRequest<Request>): RawBodyProbeResult {
    const raw = request.rawBody;

    return {
      isBuffer: Buffer.isBuffer(raw),
      raw: Buffer.isBuffer(raw) ? raw.toString('utf8') : null,
      parsedIsObject: typeof request.body === 'object' && request.body !== null,
    };
  }
}

@Module({ controllers: [RawBodyProbeController] })
export class RawBodyProbeModule {}
