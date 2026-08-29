import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installReactI18nextMock } from '../../../test-utils/reactI18nextMock';

installReactI18nextMock();

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const loadSearch = async () => {
  const module = await import(`./SettingsSearch.tsx?test=${Date.now()}-${Math.random()}`);
  return module;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  mock.restore();
});

describe('SettingsSearch', () => {
  it('matches every token without case or accent sensitivity', async () => {
    const { SettingsSearchProvider, matchesSettingsSearch, useSettingsSearch } = await loadSearch();
    let matches: ((...values: string[]) => boolean) | undefined;

    const Probe = () => {
      const search = useSettingsSearch();
      matches = search.matches;
      React.useEffect(() => search.setQuery('modele dedie'), [search]);
      return null;
    };

    await act(async () => {
      root?.render(
        <SettingsSearchProvider>
          <Probe />
        </SettingsSearchProvider>
      );
      await Promise.resolve();
    });

    expect(matches?.('Modèle dédié')).toBe(true);
    expect(matches?.('Modèle de conversation')).toBe(false);
    expect(matchesSettingsSearch('ｍｏｄｅｌｅ', 'Modèle')).toBe(true);
  });

  it('clears the query when the active tab changes', async () => {
    const { SettingsSearchBar, SettingsSearchProvider } = await loadSearch();

    await act(async () => {
      root?.render(
        <SettingsSearchProvider key="providers">
          <SettingsSearchBar placeholder="Search providers..." />
        </SettingsSearchProvider>
      );
      await Promise.resolve();
    });

    const input = container?.querySelector('input') as HTMLInputElement;
    expect(input.classList).toContain('focus-visible:[box-shadow:none]');
    await act(async () => {
      input.value = 'openai';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('openai');

    await act(async () => {
      root?.render(
        <SettingsSearchProvider key="models">
          <SettingsSearchBar placeholder="Search models..." />
        </SettingsSearchProvider>
      );
      await Promise.resolve();
    });

    expect((container?.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('renders the translated message supplied by the owning settings collection', async () => {
    const { SettingsSearchEmpty } = await loadSearch();

    await act(async () => {
      root?.render(
        <SettingsSearchEmpty message="Aucun raccourci ne correspond à votre recherche." />
      );
    });

    expect(container?.textContent).toContain('Aucun raccourci ne correspond à votre recherche.');
    expect(container?.querySelector('[data-empty-state="settings"]')).not.toBeNull();
  });
});
