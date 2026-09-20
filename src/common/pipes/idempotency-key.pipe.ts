import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Validates the Idempotency-Key header. A header cannot be validated by a
 * body DTO, so this pipe is the trust boundary for it.
 */
@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException(
        'Idempotency-Key header must be 8-128 characters of A-Z, a-z, 0-9, _ or -',
      );
    }

    return value;
  }
}
