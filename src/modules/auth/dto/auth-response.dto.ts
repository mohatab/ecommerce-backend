import { ApiProperty } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { UserResponseDto } from './user-response.dto';

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;

  static from(result: {
    accessToken: string;
    refreshToken: string;
    user: User;
  }): AuthResponseDto {
    const dto = new AuthResponseDto();

    dto.accessToken = result.accessToken;
    dto.refreshToken = result.refreshToken;
    dto.user = UserResponseDto.from(result.user);

    return dto;
  }
}
