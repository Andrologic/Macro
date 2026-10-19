import type { DesignMetadata } from '../types/agsdl';
export const launchFields = [
  { id: 'releaseVersion', label: 'Version à vérifier', description: 'Exemple : 1.8.0', icon: 'tag' },
  { id: 'releasePackages', label: 'Installateurs', description: 'Paquets iOS et Android à contrôler', icon: 'package' },
  { id: 'releaseModel', label: 'Modèle des agents', description: 'Choix utilisé pour cette exécution simulée', icon: 'bot' },
  { id: 'releaseRepository', label: 'Connexion au dépôt', description: 'Accès en lecture à Luma Mobile', icon: 'plug' },
] as const;
export const defaultLaunchRequirements = (): DesignMetadata['requirements'] => launchFields.map(field => ({ id: field.id, label: field.label, description: field.description, value: field.id === 'releaseModel' ? 'Macro AI · Équilibré' : '' }));
