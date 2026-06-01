import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Entry points Knip can't infer from framework conventions:
  // - the standalone production migration runner (invoked via `node` in Docker)
  // - server action modules, called across the RSC boundary rather than imported
  entry: [
    'scripts/db-migrate.mjs',
    'src/actions/**/*.ts',
    'src/features/**/actions.ts',
  ],
  // An export only consumed inside its own module is still "used" — don't flag it.
  ignoreExportsUsedInFile: true,
  // Files to exclude from Knip analysis
  ignore: [
    'checkly.config.ts',
    'src/components/ui/*',
    'src/libs/I18n.ts',
  ],
  // Dependencies to ignore during analysis
  ignoreDependencies: [
    '@clerk/shared',
    '@swc/helpers', // Avoid error in CI: "`npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync."
  ],
  // Include custom Playwright test file suffixes
  playwright: {
    entry: ['tests/**/*.@(integ|e2e).ts'],
  },
  // Binaries to ignore during analysis
  ignoreBinaries: [
    'production', // False positive raised with dotenv-cli
  ],
  compilers: {
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join('\n'),
  },
  treatConfigHintsAsErrors: true,
};

export default config;
