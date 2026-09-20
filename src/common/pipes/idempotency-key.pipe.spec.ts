import { BadRequestException } from '@nestjs/common';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';

describe('IdempotencyKeyPipe', () => {
  const pipe = new IdempotencyKeyPipe();

  // The boundaries are the point: a regression from {8,128} to {8,} keeps
  // every "accepted" case green, so the 129-character rejection is the only
  // assertion that catches it.
  const key = (length: number): string => 'a'.repeat(length);

  it('accepts exactly 8 characters', () => {
    expect(pipe.transform(key(8))).toBe(key(8));
  });

  it('accepts exactly 128 characters', () => {
    expect(pipe.transform(key(128))).toBe(key(128));
  });

  it('rejects 7 characters', () => {
    expect(() => pipe.transform(key(7))).toThrow(BadRequestException);
  });

  it('rejects 129 characters', () => {
    expect(() => pipe.transform(key(129))).toThrow(BadRequestException);
  });

  it('accepts the full allowed alphabet', () => {
    const value = 'AZaz09_-AZaz09_-';
    expect(pipe.transform(value)).toBe(value);
  });

  it.each([
    ['a space', 'abcdefg h'],
    ['a dot', 'abcdefg.h'],
    ['a slash', 'abcdefg/h'],
    ['a plus', 'abcdefg+h'],
    ['a newline', 'abcdefgh\n'],
    ['a unicode letter', 'abcdefgé'],
  ])('rejects a key containing %s', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345678],
    ['an array of valid keys', ['abcdefgh']],
    ['an object', { key: 'abcdefgh' }],
  ])('rejects %s, which is not a string', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
