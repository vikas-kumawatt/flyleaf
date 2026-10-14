// Rewrites incoming links before the router sees them (src/lib/appLinks.ts).
import Constants from 'expo-constants';
import { appPathFor, linkHostsFrom } from '@/lib/appLinks';

const HOSTS = linkHostsFrom(Constants.expoConfig?.extra);

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return appPathFor(path, HOSTS);
  } catch {
    return path;
  }
}
