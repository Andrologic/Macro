import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';

const schemaPaths = [
  'contracts/macro-pilot/v1/common.schema.json',
  'contracts/macro-pilot/v1/identity.schema.json',
  'contracts/macro-pilot/v1/supervision.schema.json',
  'contracts/macro-pilot/v1/protocol.schema.json',
  'contracts/macro-pilot/v1/schema.json',
  'contracts/macro-pilot/transport/schema.json',
] as const;

type JsonSchema = { $id: string } & Record<string, unknown>;

export const macroPilotSchemaPaths = (projectRoot: string): string[] =>
  schemaPaths.map((path) => resolve(projectRoot, path));

export async function generateMacroPilotValidators(projectRoot: string): Promise<string> {
  const schemas = await Promise.all(
    macroPilotSchemaPaths(projectRoot).map(async (path) =>
      JSON.parse(await readFile(path, 'utf8')) as JsonSchema
    )
  );
  const root = schemas.at(-2)!;
  const transport = schemas.at(-1)!;
  const ajv = new Ajv2020({
    strict: false,
    allErrors: false,
    messages: false,
    code: { source: true, esm: true, optimize: 2 },
  });
  addFormats(ajv, { formats: ['date-time', 'uri'] });
  for (const schema of schemas) ajv.addSchema(schema);

  const generated = standaloneCode(ajv, {
    schemaValidate: root.$id,
    resultValidate: `${transport.$id}#/$defs/deliveryResult`,
    deliveryValidate: `${transport.$id}#/$defs/delivery`,
  });
  const bundled = await build({
    stdin: {
      contents: generated,
      resolveDir: projectRoot,
      sourcefile: 'macro-pilot-schema-validators.generated.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    legalComments: 'none',
  });

  const output = bundled.outputFiles[0];
  if (!output) throw new Error('esbuild did not produce Macro Pilot validators.');
  return output.text;
}
