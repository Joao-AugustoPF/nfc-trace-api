import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { EVENT_TYPES, EventType, ObservationInput } from '../../domain/types';

const Optional = () => ValidateIf((_object: unknown, value: unknown) => value !== undefined);
const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
const Lowercase = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );

export class CreateOrderDto {
  @ApiProperty({ example: 'TCC-001', maxLength: 64 })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(64)
  codigo!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Optional()
  @IsString()
  @Trim()
  @MaxLength(500)
  descricao?: string;
}

export class ProvisionTagDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lowercase() pedidoId!: string;
  @ApiProperty({ example: '04AABBCCDDEE01' }) @IsString() @MinLength(8) @MaxLength(40) uid!: string;
  @ApiProperty({ example: 'NTAG424DNA' })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(64)
  modelo!: string;
  @ApiProperty({
    enum: ['UID', 'NDEF_ESTATICO'],
    description: 'DINAMICA resulta em 422 nesta versão.',
  })
  @IsString()
  @IsIn(['UID', 'NDEF_ESTATICO', 'DINAMICA'])
  estrategia!: string;
}

export class ActivationDto {
  @ApiProperty({
    example: true,
    description: 'Declaração do cliente; não constitui prova criptográfica.',
  })
  @IsBoolean()
  bloqueioConfirmado!: boolean;
  @ApiPropertyOptional({
    example: 'urn:nfc-trace:provisioning:00000000-0000-4000-8000-000000000001',
  })
  @Optional()
  @IsString()
  @MaxLength(512)
  referenciaNdef?: string;
}

export class ReadingDto {
  @ApiProperty({ example: '04AABBCCDDEE01' }) @IsString() @MinLength(8) @MaxLength(40) uid!: string;
  @ApiPropertyOptional({ description: 'URI NDEF decodificada; valor exato, sem trim.' })
  @Optional()
  @IsString()
  @MaxLength(512)
  ndef?: string;
  @ApiPropertyOptional()
  @Optional()
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(64)
  modelo?: string;
  @ApiPropertyOptional({ type: [String], example: ['IsoDep', 'NfcA'] })
  @Optional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tecnologias?: string[];
  @ApiPropertyOptional({ description: 'Bytes opcionais da leitura, codificados em Base64.' })
  @Optional()
  @IsString()
  @MaxLength(16384)
  @IsBase64()
  bytesBase64?: string;
}

export class ObservationDto implements ObservationInput {
  @ApiProperty({
    format: 'uuid',
    description: 'UUID v4 gerado na captura e mantido em retransmissões.',
  })
  @IsUUID('4')
  @Lowercase()
  id!: string;
  @ApiProperty({ enum: [1] }) @IsInt() @IsIn([1]) versaoContrato!: 1;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') @Lowercase() provisionamentoId!: string;
  @ApiProperty({
    enum: EVENT_TYPES,
    description: 'PROVISIONAMENTO é reservado; tentativas recebem decisão rejeitada.',
  })
  @IsIn(EVENT_TYPES)
  tipo!: EventType;
  @ApiProperty({ format: 'date-time', example: '2026-09-24T15:00:00.000Z' })
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  ocorridoEm!: string;
  @ApiProperty({ example: 'android-lab-01' })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(100)
  dispositivoId!: string;
  @ApiPropertyOptional({ description: 'Identidade declarada, sem autenticação na v1.' })
  @Optional()
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(100)
  operadorId?: string;
  @ApiProperty({ type: ReadingDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ReadingDto)
  leituraBruta!: ReadingDto;
  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @Optional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;
  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @Optional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;
}

export class PaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  pagina = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite = 20;
}
export class OrderSearchDto extends PaginationDto {
  @ApiPropertyOptional() @Optional() @IsString() @MaxLength(64) busca?: string;
}
