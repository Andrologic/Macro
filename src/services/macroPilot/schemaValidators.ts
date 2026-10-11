import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import common from '../../../contracts/macro-pilot/v1/common.schema.json';
import identity from '../../../contracts/macro-pilot/v1/identity.schema.json';
import supervision from '../../../contracts/macro-pilot/v1/supervision.schema.json';
import protocol from '../../../contracts/macro-pilot/v1/protocol.schema.json';
import root from '../../../contracts/macro-pilot/v1/schema.json';
import transport from '../../../contracts/macro-pilot/transport/schema.json';

const ajv = new Ajv2020({ strict: false, allErrors: false, messages: false });
addFormats(ajv, { formats: ['date-time', 'uri'] });
for (const schema of [common, identity, supervision, protocol, root, transport]) {
  ajv.addSchema(schema);
}

export const schemaValidate = ajv.getSchema(root.$id)!;
export const resultValidate = ajv.getSchema(`${transport.$id}#/$defs/deliveryResult`)!;
export const deliveryValidate = ajv.getSchema(`${transport.$id}#/$defs/delivery`)!;
