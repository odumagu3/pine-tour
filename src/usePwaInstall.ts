import { useEffect, useState } from 'react';

// The event isn't in the standard TS DOM lib yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Mac but is touch-capable.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

export interface PwaInstall {
  /** True while the app is not yet installed and can be prompted or guided. */
  canInstall: boolean;
  /** Already running as an installed app — hide any install UI. */
  installed: boolean;
  /** iOS has no install prompt API; show manual instructions instead. */
  needsManualInstructions: boolean;
  /** Fires the native install prompt. Resolves to true if accepted. */
  promptInstall: () => Promise<boolean>;
}

export function usePwaInstall(): PwaInstall {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);
  const ios = isIOS();

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // Keep the event so we can trigger the prompt from our own button.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = async (): Promise<boolean> => {
    if (!deferred) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') {
      setDeferred(null);
      return true;
    }
    return false;
  };

  // iOS: no event, but if not already installed we can still guide the user.
  const needsManualInstructions = ios && !installed && !deferred;
  const canInstall = !installed && (deferred !== null || needsManualInstructions);

  return { canInstall, installed, needsManualInstructions, promptInstall };
}
