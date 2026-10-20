// Rewrites incoming links before the router sees them (src/lib/appLinks.ts).
// Malformed query parameters are dropped first: the router's query parser
// can hang on them (withoutMalformedQuery).
import Constants from 'expo-constants';
import { appPathFor, linkHostsFrom, withoutMalformedQuery } from '@/lib/appLinks';

const HOSTS = linkHostsFrom(Constants.expoConfig?.extra);

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const safe = withoutMalformedQuery(path);
  try {
    return appPathFor(safe, HOSTS);
  } catch {
    return safe;
  }
}
