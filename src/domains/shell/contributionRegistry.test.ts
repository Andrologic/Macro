import { describe, expect, it } from 'bun:test';
import { ContributionRegistry, type Contribution } from './contributionRegistry';

describe('internal contribution lifecycle', () => {
  it('orders ties by stable ID and rejects collisions before notifying consumers', () => {
    const registry = new ContributionRegistry<Contribution>();
    let notifications = 0;
    registry.subscribe(() => { notifications += 1; });
    registry.register({ id: 'b', owner: 'one', order: 5 });
    registry.register({ id: 'a', owner: 'two', order: 5 });
    expect(registry.list(undefined).map(({ id }) => id)).toEqual(['a', 'b']);
    expect(() => registry.register({ id: 'b', owner: 'two', order: 0 })).toThrow('Duplicate');
    expect(notifications).toBe(2);
    expect(registry.all()[1].owner).toBe('one');
  });

  it('filters contextual availability and activation and withdraws only the owner', () => {
    const registry = new ContributionRegistry<Contribution<boolean>, boolean>();
    registry.register({ id: 'a', owner: 'one', order: 0, available: (ready) => ready });
    registry.register({ id: 'b', owner: 'two', order: 0 });
    expect(registry.get('a', false)).toBeUndefined();
    expect(registry.get('a', true)?.id).toBe('a');
    registry.setActive('a', false);
    expect(registry.get('a', true)).toBeUndefined();
    registry.setActive('a', true);
    registry.removeOwner('one');
    expect(registry.list(true).map(({ id }) => id)).toEqual(['b']);
  });

  it('an old disposer cannot remove a replacement after owner withdrawal', () => {
    const registry = new ContributionRegistry<Contribution>();
    const remove = registry.register({ id: 'a', owner: 'one', order: 0 });
    registry.removeOwner('one');
    registry.register({ id: 'a', owner: 'two', order: 0 });
    remove();
    expect(registry.get('a', undefined)?.owner).toBe('two');
  });
});
