import { emptyBlueprintFolders, nameBlueprintFolder, moveBlueprintToFolder } from '../services/blueprintFolders';
import { toPlanLocatorKey } from '../services/durableIdentity';
import { DEMO_MACRO_LIBRARY_ID } from './macroBlueprintLibrary';

/** The demo uses the same persisted organization as the navigator, never a second tree. */
export function demoNavigationPreferences() {
  let organization = emptyBlueprintFolders();
  const folders: Array<[string, string, string, string | null]> = [
    ['common-work', DEMO_MACRO_LIBRARY_ID, 'Développement', null],
    ['common-patterns', DEMO_MACRO_LIBRARY_ID, 'Patterns réutilisables', 'common-work'],
    ['common-empty', DEMO_MACRO_LIBRARY_ID, 'À explorer', null],
    ['mobile', 'demo-luma', 'Produit', null],
    ['mobile-audio', 'demo-luma', 'Audio et transcription', 'mobile'],
    ['mobile-delivery', 'demo-luma', 'Livraison', 'mobile'],
    ['mobile-checks', 'demo-luma', 'Contrôles', 'mobile-delivery'],
    ['atlas-content', 'demo-atlas', 'Contenus', null],
    ['atlas-checks', 'demo-atlas', 'Contrôles', 'atlas-content'],
    ['atlas-portal', 'demo-atlas', 'Portail client', null],
    ['atlas-empty', 'demo-atlas', 'À explorer', null],
    ['helio-incidents', 'demo-helio', 'Incidents', null],
    ['helio-checks', 'demo-helio', 'Contrôles', null],
    ['commerce-support', 'demo-meridian', 'Relation client', null],
  ];
  for (const [id, projectId, name, parent] of folders) organization = nameBlueprintFolder(organization, `project:${projectId}`, id, name, parent);
  const placements: Array<[string, string, string]> = [
    [DEMO_MACRO_LIBRARY_ID, 'macro-chantier', 'common-patterns'],
    ['demo-luma', 'demo-audio-feature', 'mobile-audio'], ['demo-luma', 'demo-voice', 'mobile-audio'],
    ['demo-luma', 'demo-release', 'mobile-checks'], ['demo-luma', 'demo-delivery', 'mobile-delivery'],
    ['demo-atlas', 'demo-editorial', 'atlas-content'], ['demo-atlas', 'demo-persistent', 'atlas-content'],
    ['demo-atlas', 'demo-approvals', 'atlas-checks'], ['demo-atlas', 'demo-fix', 'atlas-portal'], ['demo-atlas', 'demo-quality', 'atlas-checks'],
    ['demo-helio', 'demo-crisis', 'helio-incidents'], ['demo-helio', 'demo-incident', 'helio-incidents'],
    ['demo-helio', 'demo-competition', 'helio-incidents'], ['demo-helio', 'demo-ingestion', 'helio-checks'], ['demo-helio', 'demo-structured', 'helio-checks'],
    ['demo-meridian', 'demo-refund', 'commerce-support'], ['demo-meridian', 'demo-resident', 'commerce-support'],
  ];
  for (const [projectId, planId, folderId] of placements) organization = moveBlueprintToFolder(organization, `project:${projectId}`, toPlanLocatorKey({ branchName: 'main', planId }), folderId);
  organization.collapsedIds = ['atlas-checks', 'helio-incidents'];
  return {
    architectBlueprintFolders: organization,
    architectPinnedPlanIds: ['macro-assistant', 'demo-voice'].map(planId => toPlanLocatorKey({ branchName: 'main', planId })),
    architectNavigatorExpandedScopeIds: [`project:${DEMO_MACRO_LIBRARY_ID}`, 'project:demo-luma'],
  };
}
