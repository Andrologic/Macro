import releaseSource from './demo-release.agsdl.json';
import releaseMeta from './demo-release.meta.json';
import assistantSource from './demo-assistant.agsdl.json';
import assistantMeta from './demo-assistant.meta.json';
import voiceSource from './demo-voice.agsdl.json';
import voiceMeta from './demo-voice.meta.json';
import qualitySource from './demo-quality.agsdl.json';
import qualityMeta from './demo-quality.meta.json';
import ingestionSource from './demo-ingestion.agsdl.json';
import ingestionMeta from './demo-ingestion.meta.json';
import incidentSource from './demo-incident.agsdl.json';
import incidentMeta from './demo-incident.meta.json';
import refundSource from './demo-refund.agsdl.json';
import refundMeta from './demo-refund.meta.json';
import deliverySource from './demo-delivery.agsdl.json';
import deliveryMeta from './demo-delivery.meta.json';
import persistentSource from './demo-persistent.agsdl.json';
import persistentMeta from './demo-persistent.meta.json';
import residentSource from './demo-resident.agsdl.json';
import residentMeta from './demo-resident.meta.json';
import crisisSource from './demo-crisis.agsdl.json';
import crisisMeta from './demo-crisis.meta.json';
import fixSource from './demo-fix.agsdl.json';
import fixMeta from './demo-fix.meta.json';
import audioFeatureSource from './demo-audio-feature.agsdl.json';
import audioFeatureMeta from './demo-audio-feature.meta.json';
import macroAssistantSource from './macro-assistant.agsdl.json';
import macroAssistantMeta from './macro-assistant.meta.json';
import macroChantierSource from './macro-chantier.agsdl.json';
import macroChantierMeta from './macro-chantier.meta.json';
import type { PlanIcon } from '../../services/planIcon';
import type { AgsdlDisplayMetadata, DesignMetadata } from '../../types/agsdl';

/** Plan metadata kept beside each AgSDL document: what Macro shows around it, never the workflow itself. */
export interface DemoPoolMeta { title: string; description: string; projectId: string; planKind: string; icon: PlanIcon; design: DesignMetadata; display: AgsdlDisplayMetadata }
export interface DemoPoolEntry { id: string; source: unknown; meta: DemoPoolMeta }

// Order is the order of the demo library.
export const demoPool: DemoPoolEntry[] = [
  { id: 'demo-release', source: releaseSource, meta: releaseMeta as DemoPoolMeta },
  { id: 'demo-assistant', source: assistantSource, meta: assistantMeta as DemoPoolMeta },
  { id: 'demo-voice', source: voiceSource, meta: voiceMeta as DemoPoolMeta },
  { id: 'demo-quality', source: qualitySource, meta: qualityMeta as DemoPoolMeta },
  { id: 'demo-ingestion', source: ingestionSource, meta: ingestionMeta as DemoPoolMeta },
  { id: 'demo-incident', source: incidentSource, meta: incidentMeta as DemoPoolMeta },
  { id: 'demo-refund', source: refundSource, meta: refundMeta as DemoPoolMeta },
  { id: 'demo-delivery', source: deliverySource, meta: deliveryMeta as DemoPoolMeta },
  { id: 'demo-persistent', source: persistentSource, meta: persistentMeta as DemoPoolMeta },
  { id: 'demo-resident', source: residentSource, meta: residentMeta as DemoPoolMeta },
  { id: 'demo-crisis', source: crisisSource, meta: crisisMeta as DemoPoolMeta },
  { id: 'demo-fix', source: fixSource, meta: fixMeta as DemoPoolMeta },
  { id: 'demo-audio-feature', source: audioFeatureSource, meta: audioFeatureMeta as DemoPoolMeta },
  { id: 'macro-assistant', source: macroAssistantSource, meta: macroAssistantMeta as DemoPoolMeta },
  { id: 'macro-chantier', source: macroChantierSource, meta: macroChantierMeta as DemoPoolMeta },
];
