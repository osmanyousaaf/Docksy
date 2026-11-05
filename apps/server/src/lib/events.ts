import { EventEmitter } from 'node:events';
import type { AgentReport, DeploymentStatus, LogLine, AppStatus, Alert } from '@docksy/shared';

/**
 * In-process event bus connecting core (deploys) and monitoring (metrics/alerts).
 * Emit with bus.emit('deployment.finished', {...}); listen with bus.on(...).
 */
export interface BusEvents {
  'server.report': { serverId: string; report: AgentReport };
  'server.created': { serverId: string };
  'server.deleted': { serverId: string };
  'app.created': { appId: string };
  'app.deleted': { appId: string };
  'app.status': { appId: string; status: AppStatus };
  'deployment.log': { deploymentId: string; line: LogLine };
  'deployment.status': { deploymentId: string; appId: string; status: DeploymentStatus; error: string | null };
  'deployment.finished': { deploymentId: string; appId: string; status: 'succeeded' | 'failed' | 'cancelled'; error: string | null };
  'alert.fired': { alert: Alert };
  'alert.resolved': { alert: Alert };
}

class Bus {
  private ee = new EventEmitter();
  constructor() { this.ee.setMaxListeners(1000); }
  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    this.ee.emit(name, payload);
  }
  on<K extends keyof BusEvents>(name: K, fn: (p: BusEvents[K]) => void): () => void {
    this.ee.on(name, fn);
    return () => this.ee.off(name, fn);
  }
}

export const bus = new Bus();
