import { runCodec } from './connect-codec-engine';
import * as operations from './connect-bootstrap-operations';
import identity from './connect-bootstrap.identity.json';
export const HELLO = identity.hello;
export const runBootstrapCodec = () => runCodec({ ...operations, hello: HELLO, accepts: op => op === 10 });
