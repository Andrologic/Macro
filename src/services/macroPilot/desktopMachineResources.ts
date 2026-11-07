import * as ipc from '../tauriIpc';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { MachineResourceSource } from './machineResources';

/** Native transport stays outside presentation and portable wire DTOs. */
export function desktopMachineResources(instanceId: string, workspaceId: string, ports: DesktopStorePorts): MachineResourceSource {
  const projects = () => {
    const app = ports.app();
    return [...app.standaloneProjects, ...app.projectGroups.flatMap(group => group.projects)];
  };
  return {
    telemetry: async () => {
      const sample = await ipc.hostTelemetryRead();
      return { sample_id: sample.sampleId, observed_at: sample.observedAt, expires_at: sample.expiresAt,
        availability: sample.availability, reason: sample.reason, cpu_percent: sample.cpuPercent,
        memory_used_bytes: sample.memoryUsedBytes, memory_total_bytes: sample.memoryTotalBytes, reuseForMs: sample.reuseForMs };
    },
    projectKey: ref => {
      if (ref.instance_id !== instanceId || ref.workspace_id !== workspaceId) return null;
      const catalog = projects();
      const project = catalog.find(project => project.id === ref.project_id);
      if (!project?.path) return null;
      return JSON.stringify([instanceId, workspaceId, project.id, project.path]);
    },
    icon: async projectId => (await ipc.workspaceResolveProjectIcons([projectId])).find(result => result.projectId === projectId)?.icon ?? null,
  };
}
