import globalConfig from '@extension/tailwindcss-config';
import deepmerge from 'deepmerge';
import type { Config } from 'tailwindcss';

export const withUI = (tailwindConfig: Config): Config =>
  deepmerge(
    {
      presets: [globalConfig],
      content: [
        '../../packages/ui/lib/**/*.tsx',
        '../../node_modules/streamdown/dist/*.js',
      ],
    } as Config,
    tailwindConfig,
  );
