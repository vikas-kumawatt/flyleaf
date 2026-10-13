// Rewrites incoming links before the router sees them (src/lib/appLinks.ts).
import { appPathFor } from '@/lib/appLinks';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return appPathFor(path);
  } catch {
    return path;
  }
}
