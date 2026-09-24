import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { AuthenticatedActor, Role, ROLES } from '../../../../shared-kernel/actor';
import {
  AllowRoles,
  CurrentSession,
  Principal,
  PublicAccess,
} from '../../../../platform/access/http-security';
import { ManageAccounts } from '../../application/manage-accounts';
import { SignIn } from '../../application/sign-in';
import { ApiSuccess } from '../../../../platform/http/api-response';
import {
  AccountStatusResponse,
  LoginResponse,
  LogoutResponse,
  SessionResponse,
  UserResponse,
} from './responses';

class LoginDto {
  @ApiProperty({ example: 'operador.lab' })
  @IsString()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/)
  login!: string;
  @ApiProperty({ format: 'password', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  senha!: string;
}
class CreateUserDto extends LoginDto {
  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @MinLength(12)
  declare senha: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) nome!: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) perfil!: Role;
}

@ApiTags('Autenticação')
@ApiBearerAuth()
@Controller('autenticacao')
export class AuthenticationController {
  constructor(
    private readonly login: SignIn,
    private readonly accounts: ManageAccounts,
  ) {}
  @Post('login')
  @HttpCode(200)
  @PublicAccess()
  @ApiSuccess(LoginResponse)
  @ApiOperation({ summary: 'Iniciar sessão revogável (token exibido uma única vez)', security: [] })
  signIn(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.login.execute(
      body.login,
      body.senha,
      request.socket.remoteAddress ?? 'unknown',
      correlationId,
    );
  }
  @Get('sessao')
  @ApiSuccess(SessionResponse)
  @AllowRoles(...ROLES)
  @ApiOperation({ summary: 'Consultar a identidade verificada da sessão atual' })
  session(@CurrentSession() session: unknown) {
    return session;
  }
  @Post('logout')
  @ApiSuccess(LogoutResponse)
  @HttpCode(200)
  @AllowRoles(...ROLES)
  @ApiOperation({ summary: 'Revogar somente a sessão atual' })
  logout(
    @Principal() actor: AuthenticatedActor,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.accounts.signOut(actor, correlationId);
  }
}

@ApiTags('Usuários')
@ApiBearerAuth()
@AllowRoles('ADMINISTRADOR')
@Controller('usuarios')
export class UsersController {
  constructor(private readonly accounts: ManageAccounts) {}
  @Post()
  @ApiSuccess(UserResponse, 201)
  create(
    @Body() body: CreateUserDto,
    @Principal() actor: AuthenticatedActor,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.accounts.create(body, actor, correlationId);
  }
  @Post(':id/revogacao')
  @ApiSuccess(AccountStatusResponse)
  @HttpCode(200)
  revoke(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Principal() actor: AuthenticatedActor,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.accounts.revoke(id, actor, correlationId);
  }
  @Post(':id/desativacao')
  @ApiSuccess(AccountStatusResponse)
  @HttpCode(200)
  disable(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Principal() actor: AuthenticatedActor,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.accounts.revoke(id, actor, correlationId, true);
  }
}
