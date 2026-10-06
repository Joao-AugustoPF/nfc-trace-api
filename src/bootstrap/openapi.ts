import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('NFC Trace API')
      .setVersion('1.1.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        description: 'Token opaco retornado por POST /api/v1/autenticacao/login.',
      })
      .setDescription(
        'API experimental com sessões revogáveis. Identidade autenticada é registrada separadamente do operador/dispositivo declarados. HTTP 200 em eventos confirma armazenamento; a decisão informa se a movimentação foi autorizada. UID/NDEF não são autenticação criptográfica.',
      )
      .build(),
  );
}
export function configureOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, createOpenApiDocument(app), { jsonDocumentUrl: 'openapi.json' });
}
