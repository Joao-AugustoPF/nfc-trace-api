import { config as loadEnv } from 'dotenv';
import { createDataSource } from '../database/data-source';
import { ManageAccounts } from '../../bounded-contexts/identity/application/manage-accounts';
import { PostgresIdentityStore } from '../../bounded-contexts/identity/infrastructure/postgres-identity-store';
import { ScryptPasswords } from '../../bounded-contexts/identity/infrastructure/crypto';
import { NodeIds } from '../runtime';

async function main() {
  loadEnv({ quiet: true });
  const { DATABASE_URL, AUTH_BOOTSTRAP_LOGIN, AUTH_BOOTSTRAP_NAME, AUTH_BOOTSTRAP_PASSWORD } =
    process.env;
  if (!DATABASE_URL || !AUTH_BOOTSTRAP_LOGIN || !AUTH_BOOTSTRAP_NAME || !AUTH_BOOTSTRAP_PASSWORD)
    throw new Error(
      'Defina DATABASE_URL e AUTH_BOOTSTRAP_LOGIN, AUTH_BOOTSTRAP_NAME, AUTH_BOOTSTRAP_PASSWORD no ambiente local.',
    );
  const source = await createDataSource(DATABASE_URL).initialize();
  try {
    const useCase = new ManageAccounts(
      new PostgresIdentityStore(source),
      new ScryptPasswords(),
      new NodeIds(),
    );
    const user = await useCase.create(
      {
        login: AUTH_BOOTSTRAP_LOGIN,
        nome: AUTH_BOOTSTRAP_NAME,
        senha: AUTH_BOOTSTRAP_PASSWORD,
        perfil: 'ADMINISTRADOR',
      },
      null,
      'bootstrap-cli',
    );
    console.log(JSON.stringify(user));
  } finally {
    await source.destroy();
  }
}
void main().catch(() => {
  console.error(
    'Bootstrap não concluído. Confira as variáveis, as migrations e se já existem contas. Nenhuma senha será exibida.',
  );
  process.exitCode = 1;
});
