import { runCodec } from './connect-codec-engine';
import * as operations from './connect-codec-operations';
import identity from './connect-codec.identity.json';
export const HELLO = identity.hello;
export const runPersistentCodec = () => runCodec({ ...operations, hello: HELLO, accepts: op => op >= 1 && op <= 9 });
