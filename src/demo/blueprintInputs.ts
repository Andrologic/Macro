export const releaseTarget = { branchName: 'main', planId: 'demo-release' };
import type { DesignMetadata } from '../types/agsdl';
export const launchFields = [
  { id: 'releaseVersion', label: 'Version à vérifier', description: 'Exemple : 2.4.0', icon: 'tag' },
  { id: 'releasePackages', label: 'Installateurs', description: 'Paquets macOS et Windows à contrôler', icon: 'package' },
  { id: 'releaseModel', label: 'Modèle des agents', description: 'Choix utilisé pour cette exécution simulée', icon: 'bot' },
  { id: 'releaseRepository', label: 'Connexion au dépôt', description: 'Accès en lecture à Luma Mobile', icon: 'plug' },
] as const;
export type LaunchField = typeof launchFields[number]['id'];
export type LaunchValues = Record<LaunchField, string>;
export const defaultLaunchRequirements = (): DesignMetadata['requirements'] => launchFields.map(field => ({ id: field.id, label: field.label, description: field.description, value: field.id === 'releaseModel' ? 'Macro AI · Équilibré' : '' }));
export const sampleLaunchValues: LaunchValues = { releaseVersion: '2.4.0', releasePackages: 'Luma 2.4 · macOS et Windows', releaseModel: 'Macro AI · Équilibré', releaseRepository: 'GitHub · luma/mobile · lecture seule' };
