import { beforeEach, describe, expect, it, mock } from 'bun:test';

const appState = {
  selectedGroupId: null as string | null,
  selectedProjectId: null as string | null,
  activeArchitectPlanId: null as string | null,
};

mock.module('./useAppStore', () => ({
  useAppStore: {
    getState: () => appState,
  },
}));

let importCounter = 0;

const loadNeedsStore = async () => {
  importCounter += 1;
  return import(`./useNeedsStore.ts?test=${importCounter}`);
};

describe('useNeedsStore', () => {
  beforeEach(() => {
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    appState.activeArchitectPlanId = null;
  });

  it('defaults new needs to the selected global project without forcing a subproject', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [],
      selectedNeedId: null,
    });

    appState.selectedGroupId = 'macro-suite';
    appState.selectedProjectId = 'macro-api';

    const needId = useNeedsStore.getState().addNeed({
      title: 'Define mobile auth flow',
      description: 'Need a shared auth contract across the suite.',
      category: 'functional',
      status: 'identified',
      priority: 'high',
      tags: ['auth'],
    });

    const createdNeed = useNeedsStore.getState().getNeed(needId);
    expect(createdNeed?.groupId).toBe('macro-suite');
    expect(createdNeed?.projectId).toBeUndefined();
  });
});
