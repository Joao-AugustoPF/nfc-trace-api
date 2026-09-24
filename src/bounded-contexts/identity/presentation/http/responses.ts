import { ApiProperty } from '@nestjs/swagger';
import { ROLES, Role } from '../../../../shared-kernel/actor';
export class UserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() login!: string;
  @ApiProperty() nome!: string;
  @ApiProperty({ enum: ROLES }) perfil!: Role;
}
export class SessionResponse {
  @ApiProperty({ type: UserResponse }) usuario!: UserResponse;
  @ApiProperty({ format: 'date-time' }) expiraEm!: string;
}
export class LoginResponse extends SessionResponse {
  @ApiProperty({ description: 'Token opaco. Guardar no armazenamento seguro; nunca em logs.' })
  tokenAcesso!: string;
}
export class LogoutResponse {
  @ApiProperty() encerrada!: boolean;
}
export class AccountStatusResponse {
  @ApiProperty({ format: 'uuid' }) usuarioId!: string;
  @ApiProperty() sessoesRevogadas!: boolean;
  @ApiProperty() ativo!: boolean;
}
