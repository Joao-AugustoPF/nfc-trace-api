import path from 'node:path';
import tseslint from 'typescript-eslint';

function insideSource(filename) {
  const normalized = filename.replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('/src/');
  return marker < 0 ? undefined : normalized.slice(marker + 5);
}

const boundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'Dependency violates the clean architecture boundary: {{target}}' },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const source = insideSource(filename);
    if (!source) return {};
    const layer = source.match(
      /^bounded-contexts\/([^/]+)\/(domain|application|infrastructure|presentation)\//,
    );
    function checkValue(node, value) {
      if (typeof value !== 'string') return;
      const target = value.startsWith('.')
        ? insideSource(path.resolve(path.dirname(filename), value))
        : undefined;
      let allowed = true;
      if (source.startsWith('shared-kernel/')) allowed = !!target?.startsWith('shared-kernel/');
      if (layer?.[2] === 'domain' || layer?.[2] === 'application') {
        const prefix = `bounded-contexts/${layer[1]}/`;
        allowed =
          !!target &&
          (target.startsWith('shared-kernel/') ||
            target.startsWith(`${prefix}domain/`) ||
            (layer[2] === 'application' && target.startsWith(`${prefix}application/`)));
      } else if (layer && target?.startsWith('bounded-contexts/')) {
        allowed = target.startsWith(`bounded-contexts/${layer[1]}/`);
      }
      if (!allowed) context.report({ node, messageId: 'forbidden', data: { target: value } });
    }
    const check = (node) => checkValue(node, node.source?.value);
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          checkValue(node, node.arguments[0]?.value);
      },
    };
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { architecture: { rules: { boundaries } } },
    rules: {
      'architecture/boundaries': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
