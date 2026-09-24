import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateOrder } from '../../application/create-order';
import { ProvisionTag } from '../../application/provision-tag';
import { ActivateProvisioning, CloseProvisioning } from '../../application/change-provisioning';
import { RecordObservation } from '../../application/record-observation';
import { TraceabilityQueries } from '../../application/queries';
import {
  ActivationDto,
  CreateOrderDto,
  ObservationDto,
  OrderSearchDto,
  PaginationDto,
  ProvisionTagDto,
} from './dtos';
import {
  ApiSuccess,
  HistoryResponse,
  ObservationResponse,
  OrderResponse,
  ProvisioningResponse,
} from './responses';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Pedidos')
@Controller('pedidos')
export class OrdersController {
  constructor(
    private readonly create: CreateOrder,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Post()
  @ApiSuccess(OrderResponse, 201)
  createOrder(@Body() body: CreateOrderDto, @Headers('x-correlation-id') correlationId: string) {
    return this.create.execute(body, correlationId);
  }
  @Get()
  @ApiSuccess(OrderResponse, 200, true)
  list(@Query() query: OrderSearchDto) {
    return this.queries.orders(query.busca, { page: query.pagina, limit: query.limite });
  }
  @Get(':id')
  @ApiSuccess(OrderResponse)
  get(@Param('id', uuid) id: string) {
    return this.queries.order(id);
  }
  @Get(':id/eventos')
  @ApiSuccess(HistoryResponse, 200, true)
  history(@Param('id', uuid) id: string, @Query() query: PaginationDto) {
    return this.queries.history(id, { page: query.pagina, limit: query.limite });
  }
}

@ApiTags('Etiquetas')
@Controller('etiquetas')
export class TagsController {
  constructor(
    private readonly provision: ProvisionTag,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Post()
  @ApiSuccess(ProvisioningResponse, 201)
  register(@Body() body: ProvisionTagDto, @Headers('x-correlation-id') correlationId: string) {
    return this.provision.execute(body, correlationId);
  }
  @Get(':uid')
  @ApiSuccess(ProvisioningResponse)
  get(@Param('uid') uid: string) {
    return this.queries.tag(uid);
  }
}

@ApiTags('Provisionamentos')
@Controller('provisionamentos')
export class ProvisioningsController {
  constructor(
    private readonly activate: ActivateProvisioning,
    private readonly close: CloseProvisioning,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Get(':id')
  @ApiSuccess(ProvisioningResponse)
  get(@Param('id', uuid) id: string) {
    return this.queries.provisioning(id);
  }
  @Post(':id/ativacao')
  @HttpCode(200)
  @ApiSuccess(ProvisioningResponse)
  activateTag(
    @Param('id', uuid) id: string,
    @Body() body: ActivationDto,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.activate.execute(id, body, correlationId);
  }
  @Post(':id/encerramento')
  @HttpCode(200)
  @ApiSuccess(ProvisioningResponse)
  closeTag(@Param('id', uuid) id: string, @Headers('x-correlation-id') correlationId: string) {
    return this.close.execute(id, correlationId);
  }
}

@ApiTags('Eventos')
@Controller('eventos')
export class ObservationsController {
  constructor(
    private readonly record: RecordObservation,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Post()
  @HttpCode(200)
  @ApiSuccess(ObservationResponse)
  @ApiOperation({
    summary: 'Armazenar captura e recuperar decisão idempotente',
    description:
      'HTTP 200 confirma armazenamento. Consulte dados.decisao.autorizada para a operação logística.',
  })
  capture(@Body() body: ObservationDto, @Headers('x-correlation-id') correlationId: string) {
    return this.record.execute(body, correlationId);
  }
  @Get(':id')
  @ApiSuccess(ObservationResponse)
  get(@Param('id', uuid) id: string) {
    return this.queries.observation(id.toLowerCase());
  }
}
