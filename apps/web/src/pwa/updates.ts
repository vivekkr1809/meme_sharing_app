import { writable, type Readable } from '../lib/store';

export interface UpdateState {
  /** A new version was activated by the service worker; reload to use it. */
  needReload: boolean;
  /** The app shell is cached and works offline (first install only). */
  offlineReady: boolean;
}

const state = writable<UpdateState>({ needReload: false, offlineReady: false });
export const updateState: Readable<UpdateState> = state;

export function setUpdateState(patch: Partial<UpdateState>) {
  state.set({ ...state.get(), ...patch });
}

let reloadFn: () => void = () => window.location.reload();
export function setReloadFn(fn: () => void) {
  reloadFn = fn;
}
export function applyUpdate() {
  reloadFn();
}
