import ArchitectProjectNavigator from '../components/architect/ArchitectProjectNavigator';
import { DEMO_MACRO_LIBRARY_ID } from './macroBlueprintLibrary';

export default function DemoArchitectNavigator() {
  return <ArchitectProjectNavigator macroBlueprintProjectId={DEMO_MACRO_LIBRARY_ID} />;
}
