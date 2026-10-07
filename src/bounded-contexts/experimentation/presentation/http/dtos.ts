import { ApiProperty } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsUUID,
  IsString,
  MinLength,
  MaxLength,
  IsIn,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsNumber,
  ValidateIf,
  ValidateNested,
  IsObject,
  IsISO8601,
  Matches,
} from 'class-validator';
import {
  CLIENT_STAGES,
  SCENARIOS,
  ClientRecordInput,
  GroundTruthInput,
  RunInput,
  TrialInput,
} from '../../domain/types';

const lower = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );
export class ConfigurationDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) tagModel!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) antenna!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) position!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) surface!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) phoneCase!: string;
  @ApiProperty({ minimum: 100, maximum: 300000 })
  @IsInt()
  @Min(100)
  @Max(300000)
  timeoutMs!: number;
}
export class RunDto implements RunInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() id!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ enum: ['SINTETICO', 'FISICO'] })
  @IsIn(['SINTETICO', 'FISICO'])
  dataKind!: RunInput['dataKind'];
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) protocolVersion!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) apiVersion!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) mobileVersion!: string;
  @ApiProperty({ type: ConfigurationDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ConfigurationDto)
  configuration!: ConfigurationDto;
}
export class TrialDto implements Omit<TrialInput, 'runId'> {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() id!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() sessionId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) tagLabel!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) boxLabel!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) deviceId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) deviceModel!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) osVersion!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() provisioningId!: string;
  @ApiProperty({ enum: ['UID', 'NDEF_ESTATICO', 'SDM'] })
  @IsIn(['UID', 'NDEF_ESTATICO', 'SDM'])
  treatment!: TrialInput['treatment'];
  @ApiProperty({ enum: ['ESTRITA', 'REGISTRO_TARDIO'], nullable: true })
  @IsIn([null, 'ESTRITA', 'REGISTRO_TARDIO'])
  policy!: TrialInput['policy'];
  @ApiProperty({ enum: SCENARIOS }) @IsIn(SCENARIOS) scenario!: TrialInput['scenario'];
  @ApiProperty({ enum: ['LEITURA_FISICA', 'REEXECUCAO', 'SINTETICA'] })
  @IsIn(['LEITURA_FISICA', 'REEXECUCAO', 'SINTETICA'])
  mode!: TrialInput['mode'];
  @ApiProperty() @IsInt() @Min(1) @Max(1000000) ordinal!: number;
  @ApiProperty({
    enum: ['PROVISIONAMENTO', 'COLETA', 'RECEBIMENTO', 'MOVIMENTACAO', 'EXPEDICAO', 'ENTREGA'],
  })
  @IsIn(['PROVISIONAMENTO', 'COLETA', 'RECEBIMENTO', 'MOVIMENTACAO', 'EXPEDICAO', 'ENTREGA'])
  eventType!: string;
}
export class TruthDto implements Omit<GroundTruthInput, 'trialId'> {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() id!: string;
  @ApiProperty() @IsBoolean() legitimate!: boolean;
  @ApiProperty() @IsBoolean() shouldAuthorize!: boolean;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) observedBox!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) observedTag!: string;
  @ApiProperty({ description: 'Ordem conferida externamente; não inferida da API.' })
  @IsInt()
  @Min(1)
  @Max(1000000)
  observedOrdinal!: number;
  @ApiProperty({
    format: 'date-time',
    description: 'Horário declarado pelo observador, usado como contexto e não para medir duração.',
  })
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  observedAt!: string;
  @ApiProperty({ enum: ['OBSERVADOR', 'ROTEIRO_SINTETICO'] })
  @IsIn(['OBSERVADOR', 'ROTEIRO_SINTETICO'])
  source!: GroundTruthInput['source'];
  @ApiProperty() @IsBoolean() excluded!: boolean;
  @ApiProperty({
    enum: [
      'NAO_EXCLUIDA',
      'CONFIGURACAO_DIVERGENTE',
      'PROCEDIMENTO_INTERROMPIDO',
      'HARDWARE_INCOMPATIVEL',
    ],
  })
  @IsIn([
    'NAO_EXCLUIDA',
    'CONFIGURACAO_DIVERGENTE',
    'PROCEDIMENTO_INTERROMPIDO',
    'HARDWARE_INCOMPATIVEL',
  ])
  exclusionReason!: GroundTruthInput['exclusionReason'];
}
export class ClientRecordDto implements ClientRecordInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() id!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() trialId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() attemptId!: string;
  @ApiProperty({ enum: CLIENT_STAGES }) @IsIn(CLIENT_STAGES) stage!: ClientRecordInput['stage'];
  @ApiProperty({ format: 'uuid', nullable: true })
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsUUID('4')
  @lower()
  observationId!: string | null;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) deviceId!: string;
  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  occurredAt!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @lower() clockId!: string;
  @ApiProperty({ description: 'Milissegundos monotônicos; origem clockId.' })
  @IsNumber()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  monotonicMs!: number;
  @ApiProperty({ nullable: true })
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  durationMs!: number | null;
  @ApiProperty({
    enum: [
      'INSTANTE',
      'SESSAO_NFC_ATE_EVIDENCIA',
      'ENVIO_ATE_RESPOSTA',
      'LIBERACAO_ATE_DECISAO_FINAL',
      'INICIO_ATE_CONFIRMACAO_LOCAL',
      'INICIO_ATE_DECISAO_FINAL',
    ],
  })
  @IsIn([
    'INSTANTE',
    'SESSAO_NFC_ATE_EVIDENCIA',
    'ENVIO_ATE_RESPOSTA',
    'LIBERACAO_ATE_DECISAO_FINAL',
    'INICIO_ATE_CONFIRMACAO_LOCAL',
    'INICIO_ATE_DECISAO_FINAL',
  ])
  boundary!: ClientRecordInput['boundary'];
  @ApiProperty({
    nullable: true,
    description: 'Código técnico estável, sem texto livre ou credenciais.',
  })
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsIn([
    'NFC_TIMEOUT',
    'NFC_CANCELADO',
    'NFC_ERRO',
    'REINICIO',
    'SEM_RELOGIO_ORIGINAL',
    'REDE_INDISPONIVEL',
    'ENVIO_RECUSADO',
    'RESPOSTA_PERDIDA',
    'OK',
  ])
  code!: string | null;
}
export class PageDto {
  @ApiProperty({ default: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(1000000) pagina = 1;
  @ApiProperty({ default: 20 }) @Type(() => Number) @IsInt() @Min(1) @Max(100) limite = 20;
}
