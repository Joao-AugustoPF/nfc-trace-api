import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('NFC Trace API')
      .setVersion('1.0.0')
      .setDescription(
        'API experimental sem login. Operador e dispositivo são declarados. HTTP 200 em eventos confirma armazenamento; a decisão informa se a movimentação foi autorizada. UID/NDEF não são autenticação criptográfica.',
      )
      .build(),
  );
}
export function configureOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, createOpenApiDocument(app), { jsonDocumentUrl: 'openapi.json' });
}
