import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Principal, AllowRoles } from '../../../../platform/access/http-security';
import { ApiSuccess } from '../../../../platform/http/api-response';
import { AuthenticatedActor } from '../../../../shared-kernel/actor';
import { NfcAdministration } from '../../application/administration-service';
import { InspectionSnapshot } from '../../domain/inspection';
import { SessionReply } from '../../application/ports';

const Lower = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );
export class StationDto {
  @ApiProperty({
    description: 'Identificador declarado da estação; fixo durante a operação.',
    maxLength: 128,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  estacao!: string;
}
export class PrepareInspectionDto extends StationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lower() id!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lower() provisionamentoId!: string;
}
export class RfSessionDto extends StationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lower() id!: string;
  @ApiProperty({ format: 'uuid', description: 'UUID novo a cada abertura física da sessão NFC.' })
  @IsUUID('4')
  @Lower()
  sessaoRfId!: string;
  @ApiProperty({
    description: 'Confirma recuperação explícita após interrupção; não reenvia APDUs anteriores.',
  })
  @IsBoolean()
  recuperar!: boolean;
}
export class RfResponseDto extends StationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lower() comandoId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lower() sessaoRfId!: string;
  @ApiProperty({
    description: 'APDU completa, incluindo SW1/SW2 no final; sem espaços.',
    maxLength: 516,
  })
  @IsString()
  @Matches(/^(?:[0-9a-fA-F]{2}){2,258}$/)
  respostaHex!: string;
}
export class InterruptRfDto extends StationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lower() sessaoRfId!: string;
}
export class JournalQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  pagina = 1;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite = 25;
}
export class NfcInspectionPlanResponse {
  @ApiProperty({ example: 1 }) versao!: number;
  @ApiProperty({ enum: ['INSPECAO_EV2'] }) finalidade!: string;
  @ApiProperty({ format: 'uuid' }) provisionamentoId!: string;
  @ApiProperty() uid!: string;
  @ApiProperty() epoca!: number;
  @ApiProperty() estrategia!: string;
  @ApiProperty({ format: 'uuid' }) referenciaCredenciais!: string;
  @ApiProperty({ type: [Number] }) versoesChaves!: number[];
}
export class NfcInspectionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: NfcInspectionPlanResponse }) plano!: NfcInspectionPlanResponse;
  @ApiProperty() hashPlano!: string;
  @ApiProperty() administradorId!: string;
  @ApiProperty() estacao!: string;
  @ApiProperty({
    enum: ['PREPARADA', 'INSPECIONANDO', 'INSPECIONADA', 'INTERROMPIDA', 'ENCERRADA'],
  })
  status!: string;
  @ApiProperty() criadaEm!: string;
  @ApiProperty({ type: String, nullable: true }) sessaoAtivaId!: string | null;
}
export class NfcInspectionCommandResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() sequencia!: number;
  @ApiProperty() etapa!: string;
  @ApiProperty({
    description:
      'Transmitir no máximo uma vez nesta sessão RF. Repetição HTTP não autoriza reenvio NFC.',
  })
  apduHex!: string;
}
export class NfcInspectionResultResponse {
  @ApiProperty() uid!: string;
  @ApiProperty() configuracaoNdefHex!: string;
  @ApiProperty({ type: [Number] }) versoesChaves!: number[];
  @ApiProperty({ type: [Number] }) slotsAutenticados!: number[];
  @ApiProperty({
    example: false,
    description: 'Inspeção não instala chaves, não grava NDEF e não ativa vínculo.',
  })
  personalizada!: boolean;
}
export class NfcInspectionSessionResponse {
  @ApiProperty({ format: 'uuid' }) sessaoId!: string;
  @ApiProperty({ enum: ['EM_ANDAMENTO', 'CONCLUIDA', 'INTERROMPIDA'] }) status!: string;
  @ApiProperty() expiraEm!: string;
  @ApiProperty({ type: NfcInspectionCommandResponse, nullable: true })
  comando!: NfcInspectionCommandResponse | null;
  @ApiProperty({ type: NfcInspectionResultResponse, nullable: true })
  resultado!: NfcInspectionResultResponse | null;
  @ApiProperty({ type: String, nullable: true }) codigo!: string | null;
}
export class NfcAdministrationJournalResponse {
  @ApiProperty() id!: string;
  @ApiProperty() operacaoId!: string;
  @ApiProperty({ type: String, nullable: true }) sessaoId!: string | null;
  @ApiProperty() tipo!: string;
  @ApiProperty() recebidoEm!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) detalhes!: Record<string, unknown>;
}
const inspectionResponse = (s: InspectionSnapshot): NfcInspectionResponse => ({
  id: s.id,
  plano: {
    versao: s.plan.version,
    finalidade: s.plan.purpose,
    provisionamentoId: s.plan.provisioningId,
    uid: s.plan.uid,
    epoca: s.plan.epoch,
    estrategia: s.plan.strategy,
    referenciaCredenciais: s.plan.credentialReference,
    versoesChaves: s.plan.keyVersions,
  },
  hashPlano: s.planHash,
  administradorId: s.actorId,
  estacao: s.station,
  status: s.state,
  criadaEm: s.createdAt,
  sessaoAtivaId: s.activeSession,
});
const sessionResponse = (s: SessionReply): NfcInspectionSessionResponse => ({
  sessaoId: s.sessionId,
  status: s.state,
  expiraEm: s.expiresAt,
  comando: s.command
    ? {
        id: s.command.id,
        sequencia: s.command.sequence,
        etapa: s.command.step,
        apduHex: s.command.apduHex,
      }
    : null,
  resultado: s.result
    ? {
        uid: s.result.uid,
        configuracaoNdefHex: s.result.ndefSettingsHex,
        versoesChaves: s.result.keyVersions,
        slotsAutenticados: s.result.authenticatedSlots,
        personalizada: false,
      }
    : null,
  codigo: s.errorCode,
});

@ApiTags('Administração NFC')
@ApiBearerAuth()
@AllowRoles('ADMINISTRADOR')
@Controller('administracao-nfc/inspecoes')
export class NfcAdministrationController {
  constructor(private readonly service: NfcAdministration) {}
  @Post()
  @ApiSuccess(NfcInspectionResponse, 201)
  @ApiOperation({
    summary: 'Preparar plano de inspeção EV2 de vínculo pendente; exige inventário privado local.',
  })
  async prepare(@Body() b: PrepareInspectionDto, @Principal() a: AuthenticatedActor) {
    return inspectionResponse(
      await this.service.prepare(
        { id: b.id, provisioningId: b.provisionamentoId, station: b.estacao },
        a,
      ),
    );
  }
  @Get(':id')
  @ApiSuccess(NfcInspectionResponse)
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Principal() a: AuthenticatedActor,
  ) {
    return inspectionResponse(await this.service.get(id, a));
  }
  @Get(':id/diario')
  @ApiSuccess(NfcAdministrationJournalResponse, 200, true)
  async journal(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() q: JournalQuery,
    @Principal() a: AuthenticatedActor,
  ) {
    const page = await this.service.journal(id, q.pagina, q.limite, a);
    return {
      itens: page.items.map((e) => ({
        id: e.id,
        operacaoId: e.operationId,
        sessaoId: e.sessionId,
        tipo: e.type,
        recebidoEm: e.occurredAt,
        detalhes: e.details,
      })),
      total: page.total,
      pagina: q.pagina,
      limite: q.limite,
    };
  }
  @Post(':id/sessoes')
  @HttpCode(200)
  @ApiSuccess(NfcInspectionSessionResponse)
  @ApiOperation({
    summary: 'Abrir sessão RF isolada; comandos não alteram a tag. Recuperação exige UUID RF novo.',
  })
  async begin(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() b: RfSessionDto,
    @Principal() a: AuthenticatedActor,
  ) {
    return sessionResponse(
      await this.service.begin(
        id,
        { id: b.id, rfSessionId: b.sessaoRfId, station: b.estacao, recovery: b.recuperar },
        a,
      ),
    );
  }
  @Post(':id/sessoes/:sessaoId/respostas')
  @HttpCode(200)
  @ApiSuccess(NfcInspectionSessionResponse)
  @ApiOperation({
    summary:
      'Registrar resposta e obter checkpoint atual; falha EV2 armazenada retorna status INTERROMPIDA.',
  })
  async respond(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('sessaoId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body() b: RfResponseDto,
    @Principal() a: AuthenticatedActor,
  ) {
    return sessionResponse(
      await this.service.respond(
        id,
        sessionId,
        {
          commandId: b.comandoId,
          rfSessionId: b.sessaoRfId,
          station: b.estacao,
          responseHex: b.respostaHex.toUpperCase(),
        },
        a,
      ),
    );
  }
  @Post(':id/encerramento')
  @HttpCode(200)
  @ApiSuccess(NfcInspectionResponse)
  async end(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() b: StationDto,
    @Principal() a: AuthenticatedActor,
  ) {
    return inspectionResponse(await this.service.end(id, b.estacao, a));
  }
  @Post(':id/sessoes/:sessaoId/interrupcao')
  @HttpCode(200)
  @ApiSuccess(NfcInspectionSessionResponse)
  @ApiOperation({
    summary:
      'Interromper RF e conservar plano para recuperação, inclusive após novo login da conta criadora.',
  })
  async interrupt(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('sessaoId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body() b: InterruptRfDto,
    @Principal() a: AuthenticatedActor,
  ) {
    return sessionResponse(await this.service.interrupt(id, sessionId, b.sessaoRfId, b.estacao, a));
  }
}
