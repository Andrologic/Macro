import { expect, test } from 'bun:test';
import { evaluateNativeJson030 } from './native-json-oracle030';
test('native numeric oracle keeps the decimal and bit paths independent', () => {
    expect(evaluateNativeJson030({ op: 'decimal', raw: '9007199254740993' })).toEqual({ status: 'ok', bits: '4340000000000000', text: '9007199254740992' });
    expect(evaluateNativeJson030({ op: 'decimal', raw: '-0' })).toEqual({ status: 'ok', bits: '8000000000000000', text: '0' });
    expect(evaluateNativeJson030({ op: 'bits', hex: '0000000000000001' })).toEqual({ status: 'ok', text: '5e-324' });
});
test('native oracle preserves UTF-16, key order and duplicate replacement', () => {
    expect(evaluateNativeJson030({ op: 'parse', json: '{"b":"\\ud800","2":1,"1":2,"b":"\\udc00"}' })).toEqual({ status: 'ok', text: '{"1":2,"2":1,"b":"\\udc00"}', capture: { status: 'ok', text: '{"1":2,"2":1,"b":"\\udc00"}' } });
});
test('native stringify and metadata capture disagree explicitly on overflow', () => {
    expect(evaluateNativeJson030({ op: 'parse', json: '{"overflow":1e400}' })).toEqual({ status: 'ok', text: '{"overflow":null}', capture: { status: 'failure', code: 'UNSUPPORTED', pointer: '/native/overflow', message: 'Expected a plain metadata object.' } });
});
