import type { CreateDataServicesOptions, DataServices } from '../contracts';
import { Engine, type EngineTuning } from './engine';

export type { EngineTuning } from './engine';

/**
 * Create the local-first data layer: Dexie storage + the peer sync engine.
 *
 * Notes for the integrator:
 * - Resolves once local state is loaded; if a pairing secret is stored, the transport is started.
 * - After `backup.importBackup()` the devices must pair again (the secret is never exported).
 */
export function createDataServices(opts: CreateDataServicesOptions & EngineTuning): Promise<DataServices> {
  return Engine.create(opts);
}
