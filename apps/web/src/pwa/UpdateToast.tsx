import { useEffect, useRef } from 'react';
import { useReadable } from '../lib/store';
import { useToast } from '../ui/components/Toast';
import { applyUpdate, setUpdateState, updateState } from './updates';

/** Bridges service-worker update events into the app's toast system. */
export function UpdateToast() {
  const s = useReadable(updateState);
  const toast = useToast();
  const shown = useRef({ reload: false, offline: false });

  useEffect(() => {
    if (s.needReload && !shown.current.reload) {
      shown.current.reload = true;
      toast.show('A new version of Meme Pals is ready.', { duration: 0, action: { label: 'Reload', onClick: applyUpdate } });
    }
    if (s.offlineReady && !shown.current.offline) {
      shown.current.offline = true;
      toast.show('Ready to work offline ✨', { kind: 'success' });
      setUpdateState({ offlineReady: false });
    }
  }, [s, toast]);

  return null;
}
