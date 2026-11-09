import { describe, expectTypeOf, test } from 'bun:test';
import type { HumanScope030 } from './generated/ipc';
import type {
  NativeFact030,
  RunActionInputs030,
  RunActionResult030,
  RunDeliveryInput030,
  RunDeliveryReceipt030,
  RunHumanSubmission030,
  RunPreflight030,
  RunStartIntent030,
  RunStop030,
  VersionedRunCaptureUi,
} from './agsdlRunUi030';

// These assertions are checked by `bun run typecheck`. Bun executes their
// test registration, but runtime execution alone does not validate TS types.
describe('AgSDL 0.3 public product contract', () => {
  test('human submissions expose only scope, request, revision and answer', () => {
    expectTypeOf<keyof RunHumanSubmission030>().toEqualTypeOf<
      'scope' | 'requestId' | 'expectedRevision' | 'answer'
    >();
    expectTypeOf<RunHumanSubmission030['scope']>().toEqualTypeOf<Readonly<HumanScope030>>();
    expectTypeOf<Extract<keyof RunActionInputs030['start'],
      'epoch' | 'generation' | 'providerAttemptId' | 'nativeReceiptId' | 'nowMs'
    >>().toBeNever();
  });

  test('a flow choice cannot be submitted as a permission or plan decision', () => {
    expectTypeOf<RunActionInputs030['flowChoice']['answer']>().not.toMatchTypeOf<
      RunActionInputs030['actionApproval']['answer']
    >();
    expectTypeOf<RunActionInputs030['question']['answer']>().not.toMatchTypeOf<
      RunActionInputs030['plan']['answer']
    >();
    expectTypeOf<RunActionInputs030['flowChoice']['answer']['comment']>().toBeString();
    expectTypeOf<RunActionInputs030['question']['answer']['answerJson']>().toBeString();
  });

  test('external delivery excludes new instances and keeps a distinct 0.3 receipt', () => {
    expectTypeOf<RunDeliveryInput030['response']['target']['instance']['kind']>()
      .toEqualTypeOf<'shared' | 'named'>();
    expectTypeOf<RunDeliveryReceipt030['kind']>().toEqualTypeOf<'deliver030'>();
    expectTypeOf<Extract<RunDeliveryReceipt030['state'], { kind: 'absorbed' }>>()
      .toMatchTypeOf<{ targetActivationId: string; consumptionReceiptId: string }>();
  });

  test('edition narrowing cannot install a historical capture or Start receipt', () => {
    type Current = Extract<VersionedRunCaptureUi, { contract: 'agsdl-0.3.0' }>;
    type Historical = Extract<VersionedRunCaptureUi, { contract: 'agsdl-0.2.0' }>;
    expectTypeOf<Historical['capture']>().not.toMatchTypeOf<Current['capture']>();
    expectTypeOf<Current['capture']['versions']['snapshot']>().toEqualTypeOf<'2'>();
    expectTypeOf<Extract<RunStartIntent030['state'], { kind: 'admitted' }>['admission']['kind']>()
      .toEqualTypeOf<'start030'>();
  });

  test('a Stop request is not physical confirmation', () => {
    expectTypeOf<Extract<RunStop030, { kind: 'requested' }>>().not.toMatchTypeOf<
      Extract<RunStop030, { kind: 'stopped' }>
    >();
    expectTypeOf<keyof RunActionInputs030['stop']>().toEqualTypeOf<'scope' | 'id'>();
    expectTypeOf<Extract<RunStop030, { kind: 'awaitingPhysicalEnd' }>['pending']>().toBeString();
  });

  test('missing evidence and unknown submission outcomes require separate branches', () => {
    expectTypeOf<Extract<NativeFact030<boolean>, { kind: 'unavailable' }>>()
      .not.toMatchTypeOf<{ value: boolean }>();
    expectTypeOf<Extract<RunActionResult030<'steer'>, { kind: 'uncertain' }>>()
      .not.toMatchTypeOf<Extract<RunActionResult030<'steer'>, { kind: 'received' }>>();
  });

  test('a closed qualification gate cannot announce product availability', () => {
    type Closed = Extract<RunPreflight030, { launchGate: { kind: 'closed' } }>;
    expectTypeOf<Closed['productRuntimeAvailable']>().toEqualTypeOf<false>();
  });
});
