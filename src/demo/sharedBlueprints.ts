import type { DemoBlueprint } from './blueprintLaunch';

export const sharedDemoBlueprints: DemoBlueprint[] = [
  { id: 'macro-assistant', projectIds: [], shared: true, awaitsInput: true, title: 'Assistant', description: '', fields: [],
    agents: [{ title: 'Traiter votre demande', prompt: 'Répondre à la demande et présenter un résultat clair.' }] },
  { id: 'macro-chantier', projectIds: [], shared: true, title: 'Chantier coordonné', description: '', fields: [],
    agents: [
      { title: 'Préparer le chantier', prompt: 'Définir les étapes et répartir le travail.' },
      { title: 'Réaliser les changements', prompt: 'Réaliser le travail confié et transmettre les résultats.' },
      { title: 'Vérifier le résultat', prompt: 'Relire les changements et vérifier le résultat global.' },
    ] },
];
